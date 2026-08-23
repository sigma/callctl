import { Bridge } from "@callctl/bridge";
import { FakeClient, settle } from "@callctl/bridge/testing";
import { ChatCommand, ChatEvent, type ClientHello, message } from "@callctl/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatRemote } from "./chat-remote.js";

/**
 * Driven over real sockets against a real {@link Bridge}, because the whole
 * subject is routing: which of two attached Chat windows a key reaches, and what
 * happens when the one it is bound to goes away.
 */

const CHAT_OPS = [ChatCommand.GetRoster, ChatCommand.Raise];

const hello = (id: string, label?: string): ClientHello =>
  ({
    id,
    surface: "chat",
    ops: CHAT_OPS,
    ...(label !== undefined ? { label } : {}),
  }) as ClientHello;

const roster = (...ids: string[]) =>
  JSON.stringify({ conversations: ids.map((id) => ({ id, name: id, muted: false })) });

let bridge: Bridge;
let chat: ChatRemote;
let port: number;

beforeEach(async () => {
  bridge = new Bridge({ port: 0, handshakeTimeoutMs: 5000 });
  await bridge.start();
  port = bridge.address?.port ?? 0;
  chat = new ChatRemote({ bridge });
});

afterEach(() => {
  bridge.close();
});

describe("ChatRemote", () => {
  it("lists both attached clients by label", async () => {
    await FakeClient.connect(port, hello("work", "arbora.partners"));
    await FakeClient.connect(port, hello("home", "gmail.com"));
    await settle();

    expect(chat.clients()).toEqual([
      { id: "work", label: "arbora.partners" },
      { id: "home", label: "gmail.com" },
    ]);
  });

  it("keeps two bindings' counts independent", async () => {
    const work = await FakeClient.connect(port, hello("work", "arbora.partners"));
    const home = await FakeClient.connect(port, hello("home", "gmail.com"));
    await settle();

    work.send(message(ChatEvent.Roster, roster("a", "b", "c")));
    home.send(message(ChatEvent.Roster, roster("z")));
    await settle();

    expect(chat.unreadCount("work")).toBe(3);
    expect(chat.unreadCount("home")).toBe(1);
  });

  it("raises the bound client's window specifically", async () => {
    const work = await FakeClient.connect(port, hello("work"));
    const home = await FakeClient.connect(port, hello("home"));
    await settle();

    chat.raise("home");
    await settle();

    expect(home.received.map((m) => m.event)).toContain(ChatCommand.Raise);
    expect(work.received.map((m) => m.event)).not.toContain(ChatCommand.Raise);
  });

  it("an unbound key follows any available client", async () => {
    const only = await FakeClient.connect(port, hello("work"));
    await settle();

    expect(chat.resolve()).toBe("work");
    expect(chat.raise()).toBe(true);
    await settle();
    expect(only.received.map((m) => m.event)).toContain(ChatCommand.Raise);
  });

  it("a binding to an absent client resolves to nothing, never to another", async () => {
    await FakeClient.connect(port, hello("home"));
    await settle();

    // Falling back to whoever *is* attached would silently point a work key at a
    // personal account — the failure that binding exists to prevent.
    expect(chat.resolve("work")).toBeUndefined();
    expect(chat.unreadCount("work")).toBeNull();
    expect(chat.raise("work")).toBe(false);
  });

  it("discards a client's roster the moment it detaches", async () => {
    const work = await FakeClient.connect(port, hello("work", "arbora.partners"));
    await settle();
    work.send(message(ChatEvent.Roster, roster("a", "b")));
    await settle();
    expect(chat.unreadCount("work")).toBe(2);

    await work.close();
    await settle();

    // A stale count is never shown.
    expect(chat.unreadCount("work")).toBeNull();
  });

  it("remembers a detached client's label, so a binding is not left opaque", async () => {
    const work = await FakeClient.connect(port, hello("work", "arbora.partners"));
    await settle();
    await work.close();
    await settle();

    expect(chat.labelOf("work")).toBe("arbora.partners");
  });

  it("picks up a label refined after the handshake", async () => {
    // Chat's account anchor resolves late, so the client handshakes without a
    // label and improves it in place.
    const work = await FakeClient.connect(port, hello("work"));
    await settle();
    expect(chat.clients()[0]?.label).toBe("work"); // the id, for want of a name

    work.send(message("session.hello", JSON.stringify(hello("work", "arbora.partners"))));
    await settle();

    expect(chat.clients()[0]?.label).toBe("arbora.partners");
  });

  it("counts unread-and-notifying conversations only", async () => {
    const work = await FakeClient.connect(port, hello("work"));
    await settle();

    work.send(
      message(
        ChatEvent.Roster,
        JSON.stringify({
          conversations: [
            { id: "a", name: "a", muted: false },
            { id: "b", name: "b", muted: true },
          ],
        }),
      ),
    );
    await settle();

    expect(chat.unreadCount("work")).toBe(1);
    // …but the muted one is still reported, so the wire stays descriptive.
    expect(chat.roster("work")?.conversations).toHaveLength(2);
  });

  it("ignores a Meet client entirely", async () => {
    await FakeClient.connect(port, {
      id: "meet",
      surface: "meet",
      ops: ["meet.toggleMic"],
    } as ClientHello);
    await settle();

    // A Meet tab being open must not make a Chat key light up.
    expect(chat.clients()).toEqual([]);
    expect(chat.unreadCount()).toBeNull();
  });
});
