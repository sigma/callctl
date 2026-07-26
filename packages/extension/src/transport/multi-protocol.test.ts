import { describe, expect, test, vi } from "vitest";
import type { MeetPlugin } from "../plugins/plugin.js";
import { MultiProtocol } from "./multi-protocol.js";
import type { Transport } from "./transport.js";

function fakeTransport(): Transport {
  return {
    onConnect: vi.fn(),
    send: vi.fn(),
    handle: vi.fn(),
    shutdown: vi.fn(),
    acceptPlugin: vi.fn(),
  };
}

describe("MultiProtocol", () => {
  test("fans send/handle/shutdown/acceptPlugin out to every transport", () => {
    const a = fakeTransport();
    const b = fakeTransport();
    const multi = new MultiProtocol([a, b]);

    const msg = { event: "micState", data: "muted" };
    multi.send(msg);
    expect(a.send).toHaveBeenCalledWith(msg);
    expect(b.send).toHaveBeenCalledWith(msg);

    const handler = vi.fn();
    multi.handle("toggleMic", handler);
    expect(a.handle).toHaveBeenCalledWith("toggleMic", handler);
    expect(b.handle).toHaveBeenCalledWith("toggleMic", handler);

    const plugin = { ID: () => 1, installHooks: vi.fn(), installHandlers: vi.fn() } as MeetPlugin;
    multi.acceptPlugin(plugin);
    expect(a.acceptPlugin).toHaveBeenCalledWith(plugin);
    expect(b.acceptPlugin).toHaveBeenCalledWith(plugin);

    multi.shutdown();
    expect(a.shutdown).toHaveBeenCalled();
    expect(b.shutdown).toHaveBeenCalled();
  });

  test("onConnect propagates to every transport", () => {
    const a = fakeTransport();
    const b = fakeTransport();
    new MultiProtocol([a, b]).onConnect();
    expect(a.onConnect).toHaveBeenCalled();
    expect(b.onConnect).toHaveBeenCalled();
  });
});
