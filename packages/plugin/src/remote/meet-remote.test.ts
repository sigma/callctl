import {
  Command,
  type Message,
  message,
  reactionLabel,
  SessionEvent,
  StateEvent,
  StateValue,
} from "@callctl/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { MeetRemote } from "./meet-remote.js";

/**
 * A minimal stand-in for the Chrome extension: dials into the remote, records
 * every command it receives, and lets the test push state events back. Mirrors
 * `meetremote/internal/meet.Fake` from the Go integration test.
 *
 * It handshakes on connect, declaring the Meet ops a real content script's
 * plugins would have registered — the bridge routes on that derived capability
 * set and refuses a client without it (ADR 0001).
 */
class FakeExtension {
  readonly received: Message[] = [];
  closed = false;
  #ws!: WebSocket;

  constructor(readonly id = "fake-meet") {}

  async connect(port: number, ops: string[] = MEET_OPS): Promise<void> {
    this.#ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.#ws.on("message", (raw) => {
      this.received.push(JSON.parse(raw.toString()) as Message);
    });
    this.#ws.on("close", () => {
      this.closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      this.#ws.once("open", resolve);
      this.#ws.once("error", reject);
    });
    this.send(SessionEvent.Hello, JSON.stringify({ id: this.id, surface: "meet", ops }));
  }

  send(event: string, data?: string): void {
    this.#ws.send(JSON.stringify(message(event, data)));
  }

  close(): void {
    this.#ws.close();
  }
}

/** Resolve once `predicate()` holds, polling briefly (events are async). */
async function eventually(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every Meet op, as a real content script would derive it from its plugins. */
const MEET_OPS = Object.values(Command);

describe("MeetRemote", () => {
  let remote: MeetRemote;
  let changes: number;

  beforeEach(async () => {
    changes = 0;
    remote = new MeetRemote({ port: 0 });
    remote.onStateChange(() => {
      changes += 1;
    });
    await remote.start();
  });

  afterEach(() => {
    remote.close();
  });

  const port = () => {
    const addr = remote.address;
    if (addr === null) throw new Error("remote not listening");
    return addr.port;
  };

  it("defaults to mic/camera on and hand raised before any state arrives", () => {
    expect(remote.connected).toBe(false);
    expect(remote.micState()).toBe(true);
    expect(remote.cameraState()).toBe(true);
    expect(remote.handState()).toBe(false); // handLowered=false
    expect(remote.captionsState()).toBe(false); // captionsOff=true
  });

  it("marks connected and queries all state on connect", async () => {
    const ext = new FakeExtension();
    await ext.connect(port());

    await eventually(() => remote.connected);
    expect(changes).toBeGreaterThan(0);

    await eventually(() => ext.received.length >= 4);
    const events = ext.received.map((m) => m.event);
    expect(events).toContain(Command.GetMicState);
    expect(events).toContain(Command.GetCameraState);
    expect(events).toContain(Command.GetHandState);
    expect(events).toContain(Command.GetCaptionsState);
  });

  it("caches inbound state pushes and notifies listeners", async () => {
    const ext = new FakeExtension();
    await ext.connect(port());
    await eventually(() => remote.connected);

    ext.send(StateEvent.MicState, StateValue.Muted);
    await eventually(() => remote.micState() === false);

    ext.send(StateEvent.CameraState, StateValue.Muted);
    await eventually(() => remote.cameraState() === false);

    ext.send(StateEvent.HandState, StateValue.Lowered);
    await eventually(() => remote.handState() === true);

    ext.send(StateEvent.CaptionsState, StateValue.CaptionsOn);
    await eventually(() => remote.captionsState() === true);

    ext.send(StateEvent.CaptionsState, StateValue.CaptionsOff);
    await eventually(() => remote.captionsState() === false);

    ext.send(StateEvent.MicState, StateValue.Unmuted);
    await eventually(() => remote.micState() === true);
  });

  it("caches the §10 join key from callState and clears it on leave", async () => {
    const ext = new FakeExtension();
    await ext.connect(port());
    await eventually(() => remote.connected);

    expect(remote.joinedKey()).toBeNull(); // no proof before any push

    ext.send(StateEvent.CallState, "gmeet:abc-def-ghi");
    await eventually(() => remote.joinedKey() === "gmeet:abc-def-ghi");

    // "Not in a call" arrives with no data → back to null.
    ext.send(StateEvent.CallState);
    await eventually(() => remote.joinedKey() === null);
  });

  it("drops the join key when the extension disconnects", async () => {
    const ext = new FakeExtension();
    await ext.connect(port());
    await eventually(() => remote.connected);

    ext.send(StateEvent.CallState, "gmeet:abc-def-ghi");
    await eventually(() => remote.joinedKey() === "gmeet:abc-def-ghi");

    ext.close();
    // A stale key must not keep dismissing the late state once we lose detection.
    await eventually(() => !remote.connected && remote.joinedKey() === null);
  });

  it("sends commands to the connected extension", async () => {
    const ext = new FakeExtension();
    await ext.connect(port());
    await eventually(() => remote.connected);
    ext.received.length = 0; // drop the on-connect queries

    remote.toggleMic();
    remote.leave();
    remote.react("yes");

    await eventually(() => ext.received.length >= 3);
    const byEvent = new Map(ext.received.map((m) => [m.event, m.data]));
    expect(byEvent.has(Command.ToggleMic)).toBe(true);
    expect(byEvent.has(Command.LeaveCall)).toBe(true);
    expect(byEvent.get(Command.React)).toBe(reactionLabel("yes"));
  });

  it("routes to the newest Meet client without evicting the older one", async () => {
    const first = new FakeExtension("meet-1");
    await first.connect(port());
    await eventually(() => remote.connected);

    const second = new FakeExtension("meet-2");
    await second.connect(port());
    await eventually(() => second.received.length >= 4); // its own on-connect queries
    first.received.length = 0;
    second.received.length = 0;

    remote.toggleMic();

    // Last-wins: a second Meet tab is a stale leftover, so the newest one is
    // the one you mean. But it is no longer *evicted* — the shared bridge holds
    // both, which is what lets a Chat client coexist with a Meet one at all.
    await eventually(() => second.received.length >= 1);
    expect(second.received.map((m) => m.event)).toContain(Command.ToggleMic);
    expect(first.closed).toBe(false);
    expect(first.received).toEqual([]);

    first.close();
    second.close();
  });

  it("ignores a stale Meet tab's state pushes", async () => {
    const stale = new FakeExtension("meet-stale");
    await stale.connect(port());
    await eventually(() => remote.connected);

    const live = new FakeExtension("meet-live");
    await live.connect(port());
    await eventually(() => live.received.length >= 4);

    live.send(StateEvent.MicState, StateValue.Muted);
    await eventually(() => remote.micState() === false);

    // The tab commands are *not* reaching must not repaint the LEDs.
    stale.send(StateEvent.MicState, StateValue.Unmuted);
    await new Promise((r) => setTimeout(r, 50));
    expect(remote.micState()).toBe(false);

    stale.close();
    live.close();
  });

  it("goes dark when the only attached client cannot drive Meet", async () => {
    const chat = new FakeExtension("chat-1");
    await chat.connect(port(), ["chat.getRoster", "chat.raise"]);
    await new Promise((r) => setTimeout(r, 50));

    // A Chat window being open is not Meet being reachable.
    expect(remote.connected).toBe(false);
    chat.close();
  });

  it("reports not paired and drops commands when no extension is connected", () => {
    expect(remote.connected).toBe(false);
    // Should not throw even though nobody is listening.
    expect(() => remote.toggleMic()).not.toThrow();
  });

  it("ignores unknown events and non-JSON frames", async () => {
    const ext = new FakeExtension();
    await ext.connect(port());
    await eventually(() => remote.connected);

    ext.send("bogusEvent", "x");
    ext.send(StateEvent.MicState, StateValue.Muted);
    await eventually(() => remote.micState() === false);
    // mic state still updated → the bogus event didn't wedge the reader
    expect(remote.micState()).toBe(false);
  });
});
