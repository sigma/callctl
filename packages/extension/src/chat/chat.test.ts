import { ChatCommand, ChatEvent, type ChatRoster } from "@callctl/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Message, Transport } from "../core/transport/transport.js";
import { newRaisePlugin } from "./raise-plugin.js";
import type { VisibleText } from "./roster.js";
import { newRosterPlugin, RosterModel } from "./roster-plugin.js";
import { ChatSelectorRegistry } from "./selectors.js";
import { newChatSelectorsPlugin } from "./selectors-plugin.js";

/**
 * The roster is asserted **at the plugin**, through a recording transport over
 * a real DOM: what matters is the frame that would have crossed the wire.
 *
 * ⚠️ **The rendered-text semantics is not covered here, and must not be claimed
 * as covered.** jsdom does not implement `innerText` — verified: the property
 * is `undefined`, and text content returns the CSS-hidden `Unread` marker that
 * is present on *every* row. That the marker is hidden by CSS, and that layout-
 * aware text therefore separates read from unread, is **browser truth**,
 * established through the dev bridge against a live Chat session. What these
 * tests pin is everything downstream of that: the row filter, the token
 * partition, the push behaviour, and the selector override loop.
 *
 * So the fixture below reproduces the trap deliberately: every row carries the
 * hidden marker in its text content, and only the fixture's *rendered* text
 * distinguishes them. A scraper that read text content would report all four
 * rows as unread, and these tests would fail — which is the point.
 */

/** The screen-reader marker Chat puts on every row and hides with CSS. */
const HIDDEN_MARKER = "Unread";

interface RowSpec {
  /** `data-group-id`, or absent for a non-conversation entry. */
  id?: string;
  name: string;
  state: "read" | "unread" | "muted";
}

/**
 * Build a roster fixture, plus the rendered-text port for it.
 *
 * The DOM carries the hidden marker on every row (text content); the port
 * returns only what would actually be laid out. `display: none` is set too, so
 * the fixture is honest about *why* the two differ, even though jsdom will not
 * act on it.
 */
function roster(rows: RowSpec[]): VisibleText {
  const rendered = new Map<Element, string>();
  const list = document.createElement("div");
  list.setAttribute("role", "list");

  for (const spec of rows) {
    const row = document.createElement("span");
    row.setAttribute("role", "listitem");
    if (spec.id !== undefined) {
      row.setAttribute("data-group-id", spec.id);
    }

    const name = document.createElement("span");
    name.textContent = spec.name;
    row.appendChild(name);

    const marker = document.createElement("span");
    marker.textContent = HIDDEN_MARKER;
    marker.style.display = "none";
    row.appendChild(marker);

    list.appendChild(row);
    rendered.set(
      row,
      spec.state === "unread"
        ? `${spec.name}\nUnread\n1 Notification`
        : spec.state === "muted"
          ? `${spec.name}\nMuted, 1 Notification`
          : spec.name,
    );
  }

  document.body.appendChild(list);
  return (el) => rendered.get(el) ?? "";
}

/** Records what a plugin sends, and lets a test fire the handlers it registered. */
function fakeTransport() {
  const sent: Message[] = [];
  const handlers = new Map<string, (m: Message) => void>();
  const disposers: Array<() => void> = [];
  const transport: Transport = {
    onConnect: () => {},
    send: (m: Message) => {
      sent.push(m);
    },
    handle: (op: string, h: (m: Message) => void) => handlers.set(op, h),
    acceptPlugin: () => {},
    onDetach: (d) => disposers.push(d),
    detach: () => {
      for (const d of disposers) {
        d();
      }
    },
    active: () => false,
    onStatusChange: () => () => {},
  };
  return {
    sent,
    transport,
    ops: () => [...handlers.keys()],
    fire: (event: string, data?: string) => handlers.get(event)?.({ event, data }),
    rosters: () =>
      sent
        .filter((m) => m.event === ChatEvent.Roster)
        .map((m) => JSON.parse(m.data ?? "{}") as ChatRoster),
  };
}

function install(visibleText: VisibleText, registry = new ChatSelectorRegistry()) {
  const model = new RosterModel(document, registry, visibleText);
  const t = fakeTransport();
  const plugin = newRosterPlugin(model);
  plugin.installHooks(t.transport);
  plugin.installHandlers(t.transport);
  return { ...t, model, registry };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the Chat unread roster", () => {
  test("reports only unread conversations", () => {
    const t = install(
      roster([
        { id: "space/aaa", name: "Product delivery", state: "unread" },
        { id: "dm/bbb", name: "Alice", state: "read" },
        { id: "space/ccc", name: "Business & Finance", state: "unread" },
      ]),
    );

    t.transport.onConnect();

    expect(t.rosters()[0]?.conversations.map((c) => c.id)).toEqual(["space/aaa", "space/ccc"]);
  });

  test("read conversations never appear, even carrying the hidden marker", () => {
    const t = install(roster([{ id: "dm/bbb", name: "Alice", state: "read" }]));

    t.transport.onConnect();

    // The row's text content contains "Unread" — a text-content scraper would
    // report it. Only rendered text tells the truth.
    expect(document.body.textContent).toContain(HIDDEN_MARKER);
    expect(t.rosters()[0]?.conversations).toEqual([]);
  });

  test("muted-but-unread conversations appear with the flag set", () => {
    const t = install(
      roster([
        { id: "space/aaa", name: "Product delivery", state: "unread" },
        { id: "space/ddd", name: "Onboarding Arborians", state: "muted" },
      ]),
    );

    t.transport.onConnect();

    expect(t.rosters()[0]?.conversations).toEqual([
      { id: "space/aaa", name: "Product delivery", muted: false },
      { id: "space/ddd", name: "Onboarding Arborians", muted: true },
    ]);
  });

  test("non-conversation list entries never appear", () => {
    // Suggested contacts, birthday cards and "Ask Gemini" are `role=listitem`
    // too, and carry no group id — a bare role query saw 28 nodes for 16
    // conversations.
    const t = install(
      roster([
        { name: "Ask Gemini", state: "unread" },
        { id: "space/aaa", name: "Product delivery", state: "unread" },
      ]),
    );

    t.transport.onConnect();

    expect(t.rosters()[0]?.conversations.map((c) => c.name)).toEqual(["Product delivery"]);
  });

  test("the roster is pushed on connect without being asked", () => {
    const t = install(roster([{ id: "space/aaa", name: "Product delivery", state: "unread" }]));

    expect(t.sent).toEqual([]);
    t.transport.onConnect();

    expect(t.rosters()).toHaveLength(1);
  });

  test("an explicit resync also returns it", () => {
    const t = install(roster([{ id: "space/aaa", name: "Product delivery", state: "unread" }]));

    t.fire(ChatCommand.GetRoster);

    expect(t.rosters()[0]?.conversations).toHaveLength(1);
  });

  test("marking a conversation read pushes an updated roster, with no polling", async () => {
    const visible = new Map<string, string>();
    const rows: RowSpec[] = [
      { id: "space/aaa", name: "Product delivery", state: "unread" },
      { id: "space/ccc", name: "Business & Finance", state: "unread" },
    ];
    const base = roster(rows);
    const port: VisibleText = (el) => {
      const id = el.getAttribute("data-group-id") ?? "";
      return visible.get(id) ?? base(el);
    };
    const t = install(port);
    t.transport.onConnect();
    expect(t.rosters()[0]?.conversations).toHaveLength(2);

    // Read one in the browser: its rendered markers go away, and the DOM moves.
    visible.set("space/ccc", "Business & Finance");
    document.querySelector('[data-group-id="space/ccc"]')?.setAttribute("data-read", "1");

    await new Promise((r) => setTimeout(r, 200));

    expect(
      t
        .rosters()
        .at(-1)
        ?.conversations.map((c) => c.id),
    ).toEqual(["space/aaa"]);
  });

  test("a re-render that changes nothing does not push", async () => {
    const t = install(roster([{ id: "space/aaa", name: "Product delivery", state: "unread" }]));
    t.transport.onConnect();
    const before = t.rosters().length;

    document.querySelector("[role=list]")?.setAttribute("data-noise", "1");
    await new Promise((r) => setTimeout(r, 200));

    expect(t.rosters()).toHaveLength(before);
  });
});

describe("Chat selector configuration", () => {
  test("an override applies on the next observation, with no reload", () => {
    // A deploy renames the marker; the roster goes quiet.
    const port = roster([{ id: "space/aaa", name: "Product delivery", state: "unread" }]);
    const registry = new ChatSelectorRegistry({ tokens: { unread: "Non lus" } });
    const t = install(port, registry);

    t.transport.onConnect();
    expect(t.rosters()[0]?.conversations).toEqual([]);

    // Push the real token over the wire — no rebuild, no tab reload.
    registry.apply({ tokens: { unread: "Unread" } });
    t.fire(ChatCommand.GetRoster);

    expect(t.rosters().at(-1)?.conversations).toHaveLength(1);
  });

  test("the selectors plugin round-trips get and set", () => {
    const registry = new ChatSelectorRegistry();
    const persisted: unknown[] = [];
    const t = fakeTransport();
    const plugin = newChatSelectorsPlugin((c) => persisted.push(c), registry);
    plugin.installHandlers(t.transport);

    t.fire(ChatCommand.GetSelectors);
    expect(t.sent[0]?.event).toBe(ChatEvent.Selectors);

    t.fire(ChatCommand.SetSelectors, JSON.stringify({ tokens: { unread: "Non lus" } }));
    expect(registry.all().tokens.unread).toBe("Non lus");
    expect(registry.all().tokens.muted).toBe("Muted,"); // untouched group member
    expect(persisted).toHaveLength(1);
  });

  test("a malformed push cannot blank a selector out", () => {
    const registry = new ChatSelectorRegistry();
    const t = fakeTransport();
    newChatSelectorsPlugin(() => {}, registry).installHandlers(t.transport);

    t.fire(ChatCommand.SetSelectors, "}{ not json");
    t.fire(ChatCommand.SetSelectors, JSON.stringify({ tokens: { unread: "" } }));
    t.fire(ChatCommand.SetSelectors, JSON.stringify({ selectors: { row: 42 } }));

    expect(registry.all().tokens.unread).toBe("Unread");
    expect(registry.all().selectors.row).toBe('[data-group-id][role="listitem"]');
  });
});

describe("raising the window", () => {
  test("hands off to the service worker rather than calling windows itself", () => {
    // `chrome.windows` is not callable from a content script; the indirection
    // is the whole point of this plugin.
    const raise = vi.fn();
    const t = fakeTransport();
    newRaisePlugin(raise).installHandlers(t.transport);

    t.fire(ChatCommand.Raise);

    expect(raise).toHaveBeenCalledOnce();
  });

  test("takes no arguments, so it cannot navigate", () => {
    const raise = vi.fn();
    const t = fakeTransport();
    newRaisePlugin(raise).installHandlers(t.transport);

    // A target would be unused API inviting use before its semantics settle;
    // the paging key will add one additively.
    t.fire(ChatCommand.Raise, "space/aaa");

    expect(raise).toHaveBeenCalledWith();
  });
});

describe("the Chat plugin set", () => {
  test("registers exactly the ops the handshake will advertise", () => {
    const t = install(roster([]));
    newRaisePlugin(() => {}).installHandlers(t.transport);
    newChatSelectorsPlugin().installHandlers(t.transport);

    // The capability set is derived from these, so this is what routing sees.
    expect(t.ops().sort()).toEqual(
      [
        ChatCommand.GetRoster,
        ChatCommand.Raise,
        ChatCommand.GetSelectors,
        ChatCommand.SetSelectors,
      ].sort(),
    );
  });

  test("declares no MIDI address — MIDI is Meet-only", () => {
    const plugin = newRosterPlugin(new RosterModel(document, new ChatSelectorRegistry(), () => ""));
    expect((plugin as { midiCC?: unknown }).midiCC).toBeUndefined();
  });
});
