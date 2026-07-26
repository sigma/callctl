import type { Message } from "@callctl/protocol";
import { describe, expect, test, vi } from "vitest";
import type { MeetPlugin } from "../plugins/plugin.js";
import { BaseTransport, type Retargetable } from "./transport.js";
import { TransportRegistry } from "./transport-registry.js";

/** A concrete transport whose pipe is a spy, so we can assert lifecycle calls. */
class FakeTransport extends BaseTransport implements Retargetable<number> {
  readonly sent: Message[] = [];
  closed = 0;
  retargetedTo: number | undefined;

  send(message: Message): void {
    this.sent.push(message);
  }
  handle(_op: string, _h: (msg: Message) => void): void {}
  retarget(config: number): void {
    this.retargetedTo = config;
  }
  protected close(): void {
    this.closed += 1;
  }
}

function fakePlugin(): MeetPlugin {
  return { ID: () => 1, installHooks: vi.fn(), installHandlers: vi.fn() };
}

describe("TransportRegistry", () => {
  test("enable builds the transport and installs every plugin onto it", () => {
    const plugin = fakePlugin();
    const registry = new TransportRegistry([plugin]);
    const transport = new FakeTransport();

    registry.enable("ws", () => transport);

    expect(registry.isEnabled("ws")).toBe(true);
    expect(plugin.installHooks).toHaveBeenCalledWith(transport);
    expect(plugin.installHandlers).toHaveBeenCalledWith(transport);
  });

  test("enable is idempotent — a live id is not rebuilt or re-installed", () => {
    const plugin = fakePlugin();
    const registry = new TransportRegistry([plugin]);
    const factory = vi.fn(() => new FakeTransport());

    registry.enable("ws", factory);
    registry.enable("ws", factory);

    expect(factory).toHaveBeenCalledOnce();
    expect(plugin.installHooks).toHaveBeenCalledOnce();
  });

  test("disable detaches the transport and forgets it", () => {
    const registry = new TransportRegistry([]);
    const transport = new FakeTransport();
    const disposed = vi.fn();

    registry.enable("ws", () => transport);
    transport.onDetach(disposed);
    registry.disable("ws");

    expect(disposed).toHaveBeenCalledOnce(); // detach ran parked disposers
    expect(transport.closed).toBe(1); // …and closed the pipe
    expect(registry.isEnabled("ws")).toBe(false);
  });

  test("disable on an unknown id is a no-op", () => {
    const registry = new TransportRegistry([]);
    expect(() => registry.disable("nope")).not.toThrow();
  });

  test("retarget forwards config to a live, retargetable transport", () => {
    const registry = new TransportRegistry([]);
    const transport = new FakeTransport();
    registry.enable("ws", () => transport);

    registry.retarget<number>("ws", 2396);
    expect(transport.retargetedTo).toBe(2396);
  });

  test("retarget on a disabled id is a no-op", () => {
    const registry = new TransportRegistry([]);
    expect(() => registry.retarget<number>("ws", 2396)).not.toThrow();
  });
});
