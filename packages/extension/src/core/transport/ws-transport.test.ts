import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WSTransport } from "./ws-transport.js";

/**
 * A controllable stand-in for the browser `WebSocket`. WSTransport talks to the
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

/**
 * A stand-in session. Every socket opens with the mandatory handshake (ADR
 * 0001), so the first frame these tests see is always the hello — which is
 * exactly what `sentAfterHello` skips past.
 */
const SESSION = () => ({ id: "test-client", surface: "test" });

describe("WSTransport", () => {
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
    new WSTransport(2395, SESSION);
    expect(only().url).toBe("ws://127.0.0.1:2395");
  });

  test("fires onConnect when the socket opens", () => {
    const ws = new WSTransport(2395, SESSION);
    const spy = vi.fn();
    ws.onConnect = spy;
    only().open();
    expect(spy).toHaveBeenCalledOnce();
  });

  test("routes an inbound message to the matching handler", () => {
    const ws = new WSTransport(2395, SESSION);
    const handler = vi.fn();
    ws.handle("toggleMic", handler);
    only().message(JSON.stringify({ event: "toggleMic", data: "x" }));
    expect(handler).toHaveBeenCalledWith({ event: "toggleMic", data: "x" });
  });

  test("ignores unknown events and non-JSON without throwing", () => {
    const ws = new WSTransport(2395, SESSION);
    const handler = vi.fn();
    ws.handle("toggleMic", handler);
    expect(() => only().message("{not json")).not.toThrow();
    expect(() => only().message(JSON.stringify({ event: "nope" }))).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  test("send serialises only while the socket is OPEN", () => {
    const ws = new WSTransport(2395, SESSION);
    ws.send({ event: "micState", data: "muted" });
    expect(only().sent).toHaveLength(0); // not open yet

    only().open();
    ws.send({ event: "micState", data: "muted" });
    // Skip the handshake the open itself sends — it is the first frame always.
    expect(only().sent.slice(1)).toEqual([JSON.stringify({ event: "micState", data: "muted" })]);
  });

  test("the first frame after open is the handshake, with the derived op set", () => {
    const ws = new WSTransport(2395, SESSION);
    ws.handle("meet.toggleMic", vi.fn());
    ws.handle("meet.getMicState", vi.fn());

    only().open();

    // Capabilities are derived, not declared: whatever the plugins registered
    // is what travels, so the set cannot drift from the ops that exist.
    expect(JSON.parse(only().sent[0] as string)).toEqual({
      event: "session.hello",
      data: JSON.stringify({
        id: "test-client",
        surface: "test",
        ops: ["meet.toggleMic", "meet.getMicState"],
      }),
    });
  });

  test("rehandshake re-sends the session, so a late label can still travel", () => {
    let label: string | undefined;
    const ws = new WSTransport(2395, () => ({ id: "test-client", surface: "test", label }));
    only().open();
    only().sent.length = 0;

    label = "arbora.partners";
    ws.rehandshake();

    expect(JSON.parse(only().sent[0] as string).data).toContain("arbora.partners");
  });

  test("reconnects ~2s after an unexpected close", () => {
    new WSTransport(2395, SESSION);
    only().close();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("detach stops the reconnect loop", () => {
    const ws = new WSTransport(2395, SESSION);
    ws.detach();
    vi.advanceTimersByTime(10000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("detach runs parked disposers and unwires handlers", () => {
    const ws = new WSTransport(2395, SESSION);
    const disposed = vi.fn();
    ws.onDetach(disposed);
    const handler = vi.fn();
    ws.handle("toggleMic", handler);

    ws.detach();
    expect(disposed).toHaveBeenCalledOnce();

    // The handler was self-parked, so it's gone: a matching message no-ops.
    only().message(JSON.stringify({ event: "toggleMic", data: "x" }));
    expect(handler).not.toHaveBeenCalled();
  });

  test("retarget redials on the new port, keeping the reconnect loop alive", () => {
    const ws = new WSTransport(2395, SESSION);
    only().open();

    ws.retarget(2396); // closes the current socket…
    vi.advanceTimersByTime(2000); // …and the reconnect dials the new port
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe("ws://127.0.0.1:2396");
  });

  test("retarget to the same port is a no-op", () => {
    const ws = new WSTransport(2395, SESSION);
    only().open();
    ws.retarget(2395);
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(1); // socket never closed
  });

  test("active tracks the socket: false while connecting, true once open, false on close", () => {
    const ws = new WSTransport(2395, SESSION);
    expect(ws.active()).toBe(false); // connecting

    only().open();
    expect(ws.active()).toBe(true);

    only().close();
    expect(ws.active()).toBe(false);
  });

  test("onStatusChange fires on each genuine open/close transition only", () => {
    const ws = new WSTransport(2395, SESSION);
    const onChange = vi.fn();
    ws.onStatusChange(onChange);

    only().open(); // false → true
    expect(onChange).toHaveBeenCalledTimes(1);

    // A failed reconnect (close while already not-open) is not a transition.
    only().close(); // true → false
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    FakeWebSocket.instances[1].close(); // still not-open → no extra fire
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("onStatusChange unsubscribe stops delivery", () => {
    const ws = new WSTransport(2395, SESSION);
    const onChange = vi.fn();
    const off = ws.onStatusChange(onChange);
    off();
    only().open();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("retarget keeps installed handlers intact across the redial", () => {
    const ws = new WSTransport(2395, SESSION);
    const handler = vi.fn();
    ws.handle("toggleMic", handler);

    ws.retarget(2396);
    vi.advanceTimersByTime(2000);
    const fresh = FakeWebSocket.instances[1];
    fresh.open();
    fresh.message(JSON.stringify({ event: "toggleMic", data: "x" }));
    expect(handler).toHaveBeenCalledWith({ event: "toggleMic", data: "x" });
  });
});
