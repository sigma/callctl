import { type ClientHello, type Message, message, SessionEvent } from "@callctl/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Bridge } from "./bridge.js";
import { FakeClient, settle } from "./testing.js";

/**
 * Everything here is asserted **at the socket**: connect real websockets, send
 * real frames, check what came back. The interesting behaviours — coexistence,
 * last-wins, targeted routing, the loud refusal — are all wire behaviours, and
 * a test that reached into the registry instead could pass while nothing
 * actually crossed the wire.
 */

const MEET_OPS = ["meet.toggleMic", "meet.getMicState"];
const CHAT_OPS = ["chat.getRoster", "chat.raise"];

const hello = (id: string, surface: string, ops: string[], extra: Partial<ClientHello> = {}) =>
  ({ id, surface, ops, ...extra }) as ClientHello;

let bridge: Bridge;
let port: number;
const logged: string[] = [];

/**
 * Start a bridge on an OS-picked port, so tests never collide with a real
 * plugin listening on 2395.
 *
 * The handshake window is generous by default: these run alongside three other
 * packages' suites, and a tight window turns ordinary scheduler jitter into a
 * refused client. The one test that *wants* the window to close sets its own.
 */
async function startBridge(handshakeTimeoutMs = 5000): Promise<Bridge> {
  const b = new Bridge({ port: 0, log: (m) => logged.push(m), handshakeTimeoutMs });
  await b.start();
  return b;
}

beforeEach(async () => {
  logged.length = 0;
  bridge = await startBridge();
  port = bridge.address?.port ?? 0;
});

afterEach(() => {
  bridge.close();
});

describe("Bridge", () => {
  test("two clients attach simultaneously and neither evicts the other", async () => {
    const meet = await FakeClient.connect(port, hello("m1", "meet", MEET_OPS));
    const chat = await FakeClient.connect(port, hello("c1", "chat", CHAT_OPS));
    await settle();

    expect(bridge.clients.all().map((c) => c.id)).toEqual(["m1", "c1"]);
    expect(bridge.handles("meet.toggleMic")).toBe(true);
    expect(bridge.handles("chat.getRoster")).toBe(true);

    // …and both sockets are still live enough to be routed to.
    bridge.send(message("meet.toggleMic"));
    bridge.send(message("chat.getRoster"));
    expect(await meet.next()).toEqual({ event: "meet.toggleMic" });
    expect(await chat.next()).toEqual({ event: "chat.getRoster" });
  });

  test("capability queries are per-capability, not per-connection", async () => {
    await FakeClient.connect(port, hello("m1", "meet", MEET_OPS));
    await settle();

    // A Meet tab being open must not make a Chat key light up.
    expect(bridge.handles("meet.toggleMic")).toBe(true);
    expect(bridge.handles("chat.getRoster")).toBe(false);
  });

  test("a command with no client field routes last-wins", async () => {
    const first = await FakeClient.connect(port, hello("m1", "meet", MEET_OPS));
    const second = await FakeClient.connect(port, hello("m2", "meet", MEET_OPS));
    await settle();

    bridge.send(message("meet.toggleMic"));
    expect(await second.next()).toEqual({ event: "meet.toggleMic" });
    expect(first.received).toEqual([]);
  });

  test("a command with a client field routes only to that client", async () => {
    const first = await FakeClient.connect(port, hello("m1", "meet", MEET_OPS));
    const second = await FakeClient.connect(port, hello("m2", "meet", MEET_OPS));
    await settle();

    bridge.send(message("meet.toggleMic", undefined, "m1"));
    expect(await first.next()).toEqual({ event: "meet.toggleMic", client: "m1" });
    expect(second.received).toEqual([]);
  });

  test("a targeted command to a client that cannot handle the op is dropped", async () => {
    const chat = await FakeClient.connect(port, hello("c1", "chat", CHAT_OPS));
    await settle();

    expect(bridge.send(message("meet.toggleMic", undefined, "c1"))).toBe(false);
    await settle();
    expect(chat.received).toEqual([]);
  });

  test("an inbound state event is tagged with its source client", async () => {
    const chat = await FakeClient.connect(port, hello("c1", "chat", CHAT_OPS));
    const seen: Message[] = [];
    bridge.onMessage((m) => seen.push(m));
    await settle();

    chat.send(message("chat.roster", '{"conversations":[]}'));
    await settle();

    expect(seen).toEqual([{ event: "chat.roster", data: '{"conversations":[]}', client: "c1" }]);
  });

  test("disconnecting a client removes its capabilities", async () => {
    const chat = await FakeClient.connect(port, hello("c1", "chat", CHAT_OPS));
    await settle();
    expect(bridge.handles("chat.getRoster")).toBe(true);

    await chat.close();
    await settle();

    expect(bridge.handles("chat.getRoster")).toBe(false);
    expect(bridge.clients.all()).toEqual([]);
  });

  test("a re-handshake refines the label without jumping the last-wins queue", async () => {
    const first = await FakeClient.connect(port, hello("m1", "meet", MEET_OPS));
    await FakeClient.connect(port, hello("m2", "meet", MEET_OPS));
    await settle();

    first.send(
      message(SessionEvent.Hello, JSON.stringify(hello("m1", "meet", MEET_OPS, { label: "work" }))),
    );
    await settle();

    expect(bridge.clients.get("m1")?.label).toBe("work");
    // m2 is still newest: refining a label is not a re-attachment.
    expect(bridge.clients.all().map((c) => c.id)).toEqual(["m1", "m2"]);
  });

  describe("clients that share an id", () => {
    // Two connections legitimately bear one id: a second Meet tab, and — until
    // the id gained a surface discriminator — the two content scripts of a
    // single extension install. Sharing an id must never mean sharing a slot.

    test("a Meet tab does not knock a Chat client out of the registry", async () => {
      const INSTALL = "one-install-id";
      const chat = await FakeClient.connect(port, hello(INSTALL, "chat", CHAT_OPS));
      await settle();
      expect(bridge.handles("chat.getRoster")).toBe(true);

      await FakeClient.connect(port, hello(INSTALL, "meet", MEET_OPS));
      await settle();

      // The reported bug: opening a Meet knocked every Chat key dark.
      expect(bridge.handles("chat.getRoster")).toBe(true);
      expect(bridge.handles("meet.toggleMic")).toBe(true);
      bridge.send(message("chat.getRoster"));
      expect(await chat.next()).toEqual({ event: "chat.getRoster" });
    });

    test("closing a superseded socket does not evict the live client", async () => {
      const first = await FakeClient.connect(port, hello("m", "meet", MEET_OPS));
      await settle();
      const second = await FakeClient.connect(port, hello("m", "meet", MEET_OPS));
      await settle();

      await first.close();
      await settle();

      // `MeetRemote` used to guard this with `if (this.#conn === conn)`; the
      // guard was lost when the registry took over, so two Meet tabs plus one
      // close went dark until a reload.
      expect(bridge.handles("meet.toggleMic")).toBe(true);
      bridge.send(message("meet.toggleMic"));
      expect(await second.next()).toEqual({ event: "meet.toggleMic" });
    });

    test("closing the newest leaves the older one routable", async () => {
      const first = await FakeClient.connect(port, hello("m", "meet", MEET_OPS));
      await settle();
      const second = await FakeClient.connect(port, hello("m", "meet", MEET_OPS));
      await settle();

      await second.close();
      await settle();

      expect(bridge.handles("meet.toggleMic")).toBe(true);
      bridge.send(message("meet.toggleMic"));
      expect(await first.next()).toEqual({ event: "meet.toggleMic" });
    });

    test("a targeted command reaches the newest bearer of that id", async () => {
      const first = await FakeClient.connect(port, hello("m", "meet", MEET_OPS));
      await settle();
      const second = await FakeClient.connect(port, hello("m", "meet", MEET_OPS));
      await settle();

      bridge.send(message("meet.toggleMic", undefined, "m"));

      expect(await second.next()).toEqual({ event: "meet.toggleMic", client: "m" });
      expect(first.received).toEqual([]);
    });

    test("detaching one of two leaves the other's capabilities intact", async () => {
      const INSTALL = "one-install-id";
      const chat = await FakeClient.connect(port, hello(INSTALL, "chat", CHAT_OPS));
      await FakeClient.connect(port, hello(INSTALL, "meet", MEET_OPS));
      await settle();

      await chat.close();
      await settle();

      expect(bridge.handles("chat.getRoster")).toBe(false);
      expect(bridge.handles("meet.toggleMic")).toBe(true);
    });
  });

  describe("the mandatory handshake", () => {
    test("a client that speaks before handshaking is refused, loudly", async () => {
      const stale = await FakeClient.connectRaw(port);
      stale.send(message("meet.micState", "muted"));

      await stale.closed();

      expect(bridge.clients.all()).toEqual([]);
      expect(logged.join("\n")).toMatch(/refusing client.*before handshaking/s);
      // The log must name the cure, not just the symptom.
      expect(logged.join("\n")).toMatch(/reload the extension/);
    });

    test("a silent client is refused once the handshake window closes", async () => {
      bridge.close();
      bridge = await startBridge(50);
      const stale = await FakeClient.connectRaw(bridge.address?.port ?? 0);

      await stale.closed();

      expect(bridge.clients.all()).toEqual([]);
      expect(logged.join("\n")).toMatch(/refusing client.*sent no handshake/s);
    });

    test("a malformed handshake is refused rather than half-attached", async () => {
      const bad = await FakeClient.connectRaw(port);
      bad.send(message(SessionEvent.Hello, '{"surface":"chat"}')); // no id

      await bad.closed();

      expect(bridge.clients.all()).toEqual([]);
      expect(logged.join("\n")).toMatch(/malformed handshake/);
    });
  });

  test("sending with nothing attached is reported, not thrown", () => {
    expect(bridge.send(message("meet.toggleMic"))).toBe(false);
    expect(logged.join("\n")).toMatch(/dropping meet\.toggleMic/);
  });
});
