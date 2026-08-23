import type { ChatConversation } from "@callctl/protocol";
import { describe, expect, it, vi } from "vitest";

import { renderChatKeySvg, shortenLabel } from "../chat/render.js";
import type { ChatRemote } from "../remote/chat-remote.js";
import { ChatUnreadAction } from "./chat-unread-action.js";

/**
 * Mirrors `next-meeting-action.test.ts`: assert on **what the key was asked to
 * render**, never on internals. The face is the observable — everything the
 * acceptance criteria talk about (blue vs grey, badge vs no badge, the count,
 * the label) is a property of it.
 */

/** A fake SDK KeyAction capturing setImage. */
function fakeKey(id: string) {
  return { id, isKey: () => true, setImage: vi.fn(async () => {}) };
}

// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const appearEv = (action: unknown, settings: Record<string, unknown>): any => ({
  action,
  payload: { settings },
});
// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const settingsEv = (action: { id: string }, settings: Record<string, unknown>): any => ({
  action,
  payload: { settings },
});
// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const disappearEv = (action: { id: string }): any => ({ action });
// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const keyDownEv = (action: { id: string }): any => ({ action });

const unread = (id: string, muted = false): ChatConversation => ({ id, name: id, muted });

/**
 * A fake {@link ChatRemote} whose rosters are settable per client, so a test can
 * drive attach/detach and read/unread without a socket.
 */
function fakeRemote(initial: Record<string, ChatConversation[] | null> = {}) {
  let state: Record<string, ChatConversation[] | null> = { ...initial };
  const listeners = new Set<() => void>();
  const labels: Record<string, string> = {};

  const resolve = (clientId?: string): string | undefined => {
    if (clientId !== undefined && clientId !== "") {
      return state[clientId] != null ? clientId : undefined;
    }
    return Object.keys(state).find((id) => state[id] != null);
  };

  const remote = {
    clients: () => Object.keys(state).map((id) => ({ id, label: labels[id] ?? id })),
    resolve,
    labelOf: (clientId?: string) => {
      const id = resolve(clientId) ?? clientId;
      return id === undefined ? undefined : labels[id];
    },
    roster: (clientId?: string) => {
      const id = resolve(clientId);
      return id === undefined ? null : { conversations: state[id] ?? [] };
    },
    unreadCount: (clientId?: string) => {
      const id = resolve(clientId);
      return id === undefined ? null : (state[id] ?? []).filter((c) => !c.muted).length;
    },
    raise: vi.fn(() => true),
    askRoster: vi.fn(),
    onChange: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  return {
    remote: remote as unknown as ChatRemote,
    label(id: string, value: string) {
      labels[id] = value;
    },
    set(next: Record<string, ChatConversation[] | null>) {
      state = next;
      for (const l of listeners) {
        l();
      }
    },
  };
}

/** The SVG a key was last asked to render, decoded back out of the data URI. */
function lastRendered(key: ReturnType<typeof fakeKey>): string {
  const uri = key.setImage.mock.calls.at(-1)?.[0] as unknown as string;
  return Buffer.from(uri.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
}

/** The three faces, as the renderer produces them, for comparison. */
const face = (connected: boolean, count: number, label = "arbora.partners") =>
  renderChatKeySvg({ connected, count, label });

describe("ChatUnreadAction", () => {
  it("shows the count when a client is attached with unread conversations", () => {
    const f = fakeRemote({ c1: [unread("a"), unread("b"), unread("c")] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, {}));

    expect(action.face({ clientId: "", label: "", appId: "", profile: "" })).toMatchObject({
      connected: true,
      count: 3,
    });
    expect(lastRendered(key)).toContain(">3<");
  });

  it("decrements when a conversation is read, with no polling", () => {
    const f = fakeRemote({ c1: [unread("a"), unread("b")] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");
    action.onWillAppear(appearEv(key, {}));

    f.set({ c1: [unread("a")] }); // read one in the browser

    expect(lastRendered(key)).toContain(">1<");
  });

  it("never counts muted-but-unread conversations", () => {
    // Mute is a deliberate statement that a space should not interrupt, and a
    // deck key is an interrupting surface.
    const f = fakeRemote({ c1: [unread("a"), unread("b", true), unread("c", true)] });
    f.label("c1", "arbora.partners");
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, {}));

    expect(lastRendered(key)).toBe(face(true, 1));
  });

  it("is blue with no badge when connected and quiet", () => {
    const f = fakeRemote({ c1: [] });
    f.label("c1", "arbora.partners");
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, {}));

    const svg = lastRendered(key);
    expect(svg).toContain("#58a6ff"); // the same blue as unread
    expect(svg).not.toContain("#f85149"); // no badge
  });

  it("is grey, and unmistakably distinct from quiet, with no client", () => {
    const f = fakeRemote({});
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, {}));

    const absent = lastRendered(key);
    expect(absent).toContain("#484f58"); // grey glyph
    expect(absent).toContain("#15181c"); // deeper field
    expect(absent).not.toContain("#58a6ff");
    // Grey means exactly one thing: no client. Two different colour decisions
    // separate it from quiet, not one dimming step.
    expect(absent).not.toBe(face(true, 0, "Chat"));
  });

  it("discards the count immediately when the client goes away", () => {
    const f = fakeRemote({ c1: [unread("a"), unread("b")] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");
    action.onWillAppear(appearEv(key, {}));
    expect(lastRendered(key)).toContain(">2<");

    f.set({}); // Chat window closed

    // A stale count is never shown.
    const svg = lastRendered(key);
    expect(svg).not.toContain(">2<");
    expect(svg).toContain("#484f58");
  });

  it("renders a bound-but-absent key as no-client, not as a fourth visual", () => {
    // "Nothing attached" and "my client is away" are the same thing from the
    // key's point of view, and both are fixed by pressing it.
    const f = fakeRemote({ other: [unread("a")] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { clientId: "mine" }));

    expect(lastRendered(key)).toBe(face(false, 0, "Chat"));
  });

  it("stops painting a key that disappeared", () => {
    const f = fakeRemote({ c1: [unread("a")] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");
    action.onWillAppear(appearEv(key, {}));
    const before = key.setImage.mock.calls.length;

    action.onWillDisappear(disappearEv(key));
    f.set({ c1: [] });

    expect(key.setImage.mock.calls.length).toBe(before);
  });

  describe("the label", () => {
    it("renders TLD-stripped", () => {
      const f = fakeRemote({ c1: [] });
      f.label("c1", "arbora.partners");
      const action = new ChatUnreadAction("uuid", f.remote);
      const key = fakeKey("k1");

      action.onWillAppear(appearEv(key, {}));

      expect(lastRendered(key)).toContain(">arbora<");
      expect(lastRendered(key)).not.toContain("arbora.partners");
    });

    it("is replaced by a user override", () => {
      const f = fakeRemote({ c1: [] });
      f.label("c1", "arbora.partners");
      const action = new ChatUnreadAction("uuid", f.remote);
      const key = fakeKey("k1");
      action.onWillAppear(appearEv(key, {}));

      action.onDidReceiveSettings(settingsEv(key, { label: "work" }));

      expect(lastRendered(key)).toContain(">work<");
    });
  });
});

describe("pressing the key", () => {
  it("raises the bound client's window, not another's", () => {
    const f = fakeRemote({ work: [unread("a")], personal: [] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");
    action.onWillAppear(appearEv(key, { clientId: "personal" }));

    action.onKeyDown(keyDownEv(key));

    expect(f.remote.raise).toHaveBeenCalledWith("personal");
  });

  it("an unbound key raises whichever client is available", () => {
    const f = fakeRemote({ work: [] });
    const action = new ChatUnreadAction("uuid", f.remote);
    const key = fakeKey("k1");
    action.onWillAppear(appearEv(key, {}));

    action.onKeyDown(keyDownEv(key));

    // Empty binding means "any client with the capability", so the remote does
    // the resolving — the key does not pick one itself.
    expect(f.remote.raise).toHaveBeenCalledWith("");
  });
});

describe("shortenLabel", () => {
  it("keeps the first dot-label only", () => {
    expect(shortenLabel("arbora.partners")).toBe("arbora");
    expect(shortenLabel("gmail.com")).toBe("gmail");
  });

  it("reduces a two-part public suffix correctly", () => {
    expect(shortenLabel("acme.co.uk")).toBe("acme");
  });

  it("leaves a dotless fallback label alone", () => {
    expect(shortenLabel("Chat u/1")).toBe("Chat u/1");
    expect(shortenLabel("Chat · 4f2a")).toBe("Chat · 4f2a");
  });
});

describe("the rendered face", () => {
  it("draws one- and two-digit counts at the same glyph size", () => {
    // The badge is load-bearing — quiet and unread differ only by it — so both
    // magnitudes must read at key size. The badge widens into a pill for two
    // digits instead of shrinking them.
    const one = renderChatKeySvg({ connected: true, count: 9, label: "x" });
    const two = renderChatKeySvg({ connected: true, count: 12, label: "x" });
    const size = (svg: string) => /font-size="(\d+)"[^>]*>\d+</.exec(svg)?.[1];

    expect(size(one)).toBe(size(two));
    expect(two).toContain(">12<");
  });

  it("never draws a badge with no client behind it", () => {
    expect(renderChatKeySvg({ connected: false, count: 7, label: "x" })).not.toContain(">7<");
  });
});
