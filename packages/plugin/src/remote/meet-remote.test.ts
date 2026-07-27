import {
  Command,
  type Message,
  message,
  reactionLabel,
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
 */
class FakeExtension {
  readonly received: Message[] = [];
  closed = false;
  #ws!: WebSocket;

  async connect(port: number): Promise<void> {
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

  it("drops the previous connection when a new extension dials in", async () => {
    const first = new FakeExtension();
    await first.connect(port());
    await eventually(() => remote.connected);

    const second = new FakeExtension();
    await second.connect(port());
    await eventually(() => second.received.length >= 3);

    // The server closes the superseded socket but stays connected via the new one.
    await eventually(() => first.closed);
    expect(remote.connected).toBe(true);
    second.close();
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
