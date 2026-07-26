import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WSProtocol } from "./ws-protocol.js";

/**
 * A controllable stand-in for the browser `WebSocket`. WSProtocol talks to the
 * global `WebSocket`, so we swap it out and drive the lifecycle by hand — this
 * is the mirror image of the plugin side's `meet-remote.test.ts`, which spins a
 * real server and dials in; here we exercise the *client's* dispatch/reconnect
 * logic in isolation, deterministically.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }
}

describe("WSProtocol", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const only = () => {
    expect(FakeWebSocket.instances).toHaveLength(1);
    return FakeWebSocket.instances[0];
  };

  test("dials the loopback bridge on the configured port", () => {
    new WSProtocol(2395);
    expect(only().url).toBe("ws://127.0.0.1:2395");
  });

  test("fires onConnect when the socket opens", () => {
    const ws = new WSProtocol(2395);
    const spy = vi.fn();
    ws.onConnect = spy;
    only().open();
    expect(spy).toHaveBeenCalledOnce();
  });

  test("routes an inbound message to the matching handler", () => {
    const ws = new WSProtocol(2395);
    const handler = vi.fn();
    ws.handle("toggleMic", handler);
    only().message(JSON.stringify({ event: "toggleMic", data: "x" }));
    expect(handler).toHaveBeenCalledWith({ event: "toggleMic", data: "x" });
  });

  test("ignores unknown events and non-JSON without throwing", () => {
    const ws = new WSProtocol(2395);
    const handler = vi.fn();
    ws.handle("toggleMic", handler);
    expect(() => only().message("{not json")).not.toThrow();
    expect(() => only().message(JSON.stringify({ event: "nope" }))).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  test("send serialises only while the socket is OPEN", () => {
    const ws = new WSProtocol(2395);
    ws.send({ event: "micState", data: "muted" });
    expect(only().sent).toHaveLength(0); // not open yet

    only().open();
    ws.send({ event: "micState", data: "muted" });
    expect(only().sent).toEqual([JSON.stringify({ event: "micState", data: "muted" })]);
  });

  test("reconnects ~2s after an unexpected close", () => {
    new WSProtocol(2395);
    only().close();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("shutdown stops the reconnect loop", () => {
    const ws = new WSProtocol(2395);
    ws.shutdown();
    vi.advanceTimersByTime(10000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
