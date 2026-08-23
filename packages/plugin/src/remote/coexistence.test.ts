import { Bridge } from "@callctl/bridge";
import { FakeClient, settle } from "@callctl/bridge/testing";
import { ChatCommand, ChatEvent, type ClientHello, Command, message } from "@callctl/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatRemote } from "./chat-remote.js";
import { MeetRemote } from "./meet-remote.js";

/**
 * The reported bug, at the level it was actually seen: *"whenever I open a
 * Google Meet, the various Chat buttons disconnect, and they only reconnect
 * when I reload their respective pages."*
 *
 * Both content scripts ship in one extension install, so both read the same
 * `clientId` out of the same per-profile store — and a registry keyed by that id
 * conflated them. Opening Meet replaced the Chat client's registry entry, so
 * `handles("chat.getRoster")` went false and every Chat key painted the
 * no-client face; reloading Chat swapped the damage back the other way.
 *
 * These drive both remotes over one real bridge, exactly as `plugin.ts` wires
 * them, because the defect only exists where the two surfaces meet.
 */

const MEET_OPS = Object.values(Command);
const CHAT_OPS = [ChatCommand.GetRoster, ChatCommand.Raise];

/** What the extension sends: one install id, scoped by surface. */
const hello = (install: string, surface: "meet" | "chat"): ClientHello =>
  ({
    id: `${install}:${surface}`,
    surface,
    ops: surface === "meet" ? MEET_OPS : CHAT_OPS,
  }) as ClientHello;

let bridge: Bridge;
let meet: MeetRemote;
let chat: ChatRemote;
let port: number;

beforeEach(async () => {
  bridge = new Bridge({ port: 0, handshakeTimeoutMs: 5000 });
  await bridge.start();
  port = bridge.address?.port ?? 0;
  meet = new MeetRemote({ bridge });
  chat = new ChatRemote({ bridge });
});

afterEach(() => {
  bridge.close();
});

describe("Meet and Chat from one extension install", () => {
  it("both stay live when Meet opens after Chat", async () => {
    const chatClient = await FakeClient.connect(port, hello("install", "chat"));
    await settle();
    expect(chat.clients()).toHaveLength(1);

    await FakeClient.connect(port, hello("install", "meet"));
    await settle();

    // The regression: opening a Meet must not knock the Chat keys dark.
    expect(chat.clients()).toHaveLength(1);
    expect(chat.unreadCount()).not.toBeNull();
    expect(meet.connected).toBe(true);

    // …and the Chat client is still actually reachable, not merely listed.
    chat.askRoster();
    await settle();
    expect(chatClient.received.map((m) => m.event)).toContain(ChatCommand.GetRoster);
  });

  it("both stay live when Chat opens after Meet", async () => {
    await FakeClient.connect(port, hello("install", "meet"));
    await settle();

    await FakeClient.connect(port, hello("install", "chat"));
    await settle();

    // The other direction — reloading Chat used to fix Chat by breaking Meet.
    expect(meet.connected).toBe(true);
    expect(chat.clients()).toHaveLength(1);
  });

  it("keeps the unread count across a Meet opening", async () => {
    const chatClient = await FakeClient.connect(port, hello("install", "chat"));
    await settle();
    chatClient.send(
      message(
        ChatEvent.Roster,
        JSON.stringify({ conversations: [{ id: "a", name: "a", muted: false }] }),
      ),
    );
    await settle();
    expect(chat.unreadCount()).toBe(1);

    await FakeClient.connect(port, hello("install", "meet"));
    await settle();

    // Not merely "still connected": the count itself must survive, since a
    // dropped client is what discards a roster.
    expect(chat.unreadCount()).toBe(1);
  });

  it("closing the Meet tab leaves Chat untouched", async () => {
    await FakeClient.connect(port, hello("install", "chat"));
    const meetClient = await FakeClient.connect(port, hello("install", "meet"));
    await settle();

    await meetClient.close();
    await settle();

    expect(meet.connected).toBe(false);
    expect(chat.clients()).toHaveLength(1);
  });

  it("closing the Chat window leaves Meet untouched", async () => {
    const chatClient = await FakeClient.connect(port, hello("install", "chat"));
    await FakeClient.connect(port, hello("install", "meet"));
    await settle();

    await chatClient.close();
    await settle();

    expect(chat.clients()).toEqual([]);
    expect(meet.connected).toBe(true);
  });

  it("a Meet command never reaches the Chat client", async () => {
    const chatClient = await FakeClient.connect(port, hello("install", "chat"));
    const meetClient = await FakeClient.connect(port, hello("install", "meet"));
    await settle();
    meetClient.received.length = 0;

    meet.toggleMic();
    await settle();

    // Routing is by capability, so the shared install cannot cross the streams.
    expect(meetClient.received.map((m) => m.event)).toContain(Command.ToggleMic);
    expect(chatClient.received.map((m) => m.event)).not.toContain(Command.ToggleMic);
  });

  it("a second Meet tab does not take the first one's Chat sibling down", async () => {
    await FakeClient.connect(port, hello("install", "chat"));
    const first = await FakeClient.connect(port, hello("install", "meet"));
    await FakeClient.connect(port, hello("install", "meet"));
    await settle();

    await first.close();
    await settle();

    expect(meet.connected).toBe(true);
    expect(chat.clients()).toHaveLength(1);
  });
});
