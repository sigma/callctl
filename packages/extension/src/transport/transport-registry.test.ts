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
  #active = false;

  send(message: Message): void {
    this.sent.push(message);
  }
  handle(_op: string, _h: (msg: Message) => void): void {}
  retarget(config: number): void {
    this.retargetedTo = config;
  }
  override active(): boolean {
    return this.#active;
  }
  /** Flip liveness and notify subscribers through the base-class emitter. */
  setActive(value: boolean): void {
    this.#active = value;
    this.refreshStatus();
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

  describe("status aggregation", () => {
    test("snapshot lists only enabled transports, each with its live active()", () => {
      const registry = new TransportRegistry([]);
      const ws = new FakeTransport();
      const midi = new FakeTransport();
      registry.enable("ws", () => ws);
      registry.enable("midi", () => midi);

      expect(registry.snapshot()).toEqual({ ws: false, midi: false });

      ws.setActive(true);
      expect(registry.snapshot()).toEqual({ ws: true, midi: false });
    });

    test("a disabled transport is absent from the snapshot (not false)", () => {
      const registry = new TransportRegistry([]);
      registry.enable("ws", () => new FakeTransport());
      registry.disable("ws");
      expect(registry.snapshot()).toEqual({});
    });

    test("subscribe fires when a live transport flips active", () => {
      const registry = new TransportRegistry([]);
      const ws = new FakeTransport();
      registry.enable("ws", () => ws);
      const onChange = vi.fn();
      registry.subscribe(onChange);

      ws.setActive(true);
      expect(onChange).toHaveBeenCalledOnce();
    });

    test("subscribe fires when the live set changes (enable / disable)", () => {
      const registry = new TransportRegistry([]);
      const onChange = vi.fn();
      registry.subscribe(onChange);

      registry.enable("ws", () => new FakeTransport());
      expect(onChange).toHaveBeenCalledTimes(1);
      registry.disable("ws");
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    test("a disabled transport no longer drives the aggregate feed", () => {
      const registry = new TransportRegistry([]);
      const ws = new FakeTransport();
      registry.enable("ws", () => ws);
      const onChange = vi.fn();
      registry.subscribe(onChange);
      registry.disable("ws"); // 1 call for the set change
      onChange.mockClear();

      ws.setActive(true); // its subscription was dropped → silent
      expect(onChange).not.toHaveBeenCalled();
    });

    test("unsubscribe stops delivery", () => {
      const registry = new TransportRegistry([]);
      const ws = new FakeTransport();
      registry.enable("ws", () => ws);
      const onChange = vi.fn();
      const unsubscribe = registry.subscribe(onChange);
      unsubscribe();

      ws.setActive(true);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
