import { describe, expect, test, vi } from "vitest";
import type { MidiDeviceRef } from "../config.js";
import type { MeetPlugin } from "../plugins/plugin.js";
import { MidiTransport } from "./midi-transport.js";

/**
 * Controllable stand-ins for the Web MIDI API — jsdom has none. We drive the
 * lifecycle by hand: acquire access, flush the `requestMIDIAccess` microtask,
 * then simulate hotplug/unplug by mutating the input map and firing
 * `onstatechange`, exactly as a browser would.
 */
class FakeInput {
  onmidimessage: ((ev: MIDIMessageEvent) => void) | null = null;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly manufacturer: string,
    public state: "connected" | "disconnected" = "connected",
  ) {}
  /** Deliver a raw MIDI message to whatever callback is bound (none ⇒ dropped). */
  emit(bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) } as MIDIMessageEvent);
  }
}

class FakeAccess {
  onstatechange: (() => void) | null = null;
  readonly inputs = new Map<string, FakeInput>();
  constructor(inputs: FakeInput[]) {
    for (const input of inputs) {
      this.inputs.set(input.id, input);
    }
  }
  /** Simulate a device event: mutate the map/state, then notify like a browser. */
  statechange(mutate: () => void): void {
    mutate();
    this.onstatechange?.();
  }
}

function fakeNav(access: FakeAccess): Navigator {
  return { requestMIDIAccess: () => Promise.resolve(access) } as unknown as Navigator;
}

/** A plugin that registers one handler under ordinal 0 for CC controller `id`. */
function fakePlugin(id: number, handler: (msg: unknown) => void): MeetPlugin {
  return {
    ID: () => id,
    installHooks: vi.fn(),
    installHandlers: (t) => t.handle("op", handler as (msg: never) => void),
  } as unknown as MeetPlugin;
}

/** Flush the `requestMIDIAccess` promise so the constructor has bound inputs. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const ref = (id: string, name = id, manufacturer = "acme"): MidiDeviceRef => ({
  id,
  name,
  manufacturer,
});

const bound = (input: FakeInput) => input.onmidimessage !== null;

describe("MidiTransport", () => {
  test("'all' binds every connected input", async () => {
    const a = new FakeInput("a", "A", "acme");
    const b = new FakeInput("b", "B", "acme");
    const access = new FakeAccess([a, b]);
    new MidiTransport("all", fakeNav(access));
    await flush();
    expect(bound(a)).toBe(true);
    expect(bound(b)).toBe(true);
  });

  test("a selection binds only the chosen inputs (by id)", async () => {
    const a = new FakeInput("a", "A", "acme");
    const b = new FakeInput("b", "B", "acme");
    const access = new FakeAccess([a, b]);
    new MidiTransport([ref("b")], fakeNav(access));
    await flush();
    expect(bound(a)).toBe(false);
    expect(bound(b)).toBe(true);
  });

  test("falls back to name+manufacturer when the id has drifted", async () => {
    // Same device, new session ⇒ new volatile id, but stable name+manufacturer.
    const input = new FakeInput("new-id", "Launch Control", "Novation");
    const access = new FakeAccess([input]);
    new MidiTransport([ref("old-id", "Launch Control", "Novation")], fakeNav(access));
    await flush();
    expect(bound(input)).toBe(true);
  });

  test("skips a disconnected input still lingering in the map", async () => {
    const input = new FakeInput("a", "A", "acme", "disconnected");
    const access = new FakeAccess([input]);
    new MidiTransport("all", fakeNav(access));
    await flush();
    expect(bound(input)).toBe(false);
  });

  test("hotplug: a newly connected, selected device gets bound live", async () => {
    const access = new FakeAccess([]);
    new MidiTransport([ref("late")], fakeNav(access));
    await flush();

    const late = new FakeInput("late", "Late", "acme");
    access.statechange(() => access.inputs.set(late.id, late));
    expect(bound(late)).toBe(true);
  });

  test("unplug: a removed device is unbound", async () => {
    const input = new FakeInput("a", "A", "acme");
    const access = new FakeAccess([input]);
    new MidiTransport("all", fakeNav(access));
    await flush();
    expect(bound(input)).toBe(true);

    access.statechange(() => access.inputs.delete("a"));
    expect(bound(input)).toBe(false);
  });

  test("retarget re-selects the bound inputs live", async () => {
    const a = new FakeInput("a", "A", "acme");
    const b = new FakeInput("b", "B", "acme");
    const access = new FakeAccess([a, b]);
    const midi = new MidiTransport([ref("a")], fakeNav(access));
    await flush();
    expect(bound(a)).toBe(true);
    expect(bound(b)).toBe(false);

    midi.retarget([ref("b")]);
    expect(bound(a)).toBe(false);
    expect(bound(b)).toBe(true);
  });

  test("detach unbinds inputs and drops the statechange listener", async () => {
    const input = new FakeInput("a", "A", "acme");
    const access = new FakeAccess([input]);
    const midi = new MidiTransport("all", fakeNav(access));
    await flush();
    expect(bound(input)).toBe(true);

    midi.detach();
    expect(bound(input)).toBe(false);
    expect(access.onstatechange).toBeNull();

    // A later hotplug must not re-bind a detached transport.
    const late = new FakeInput("late", "Late", "acme");
    access.inputs.set(late.id, late);
    access.onstatechange?.();
    expect(bound(late)).toBe(false);
  });

  test("active is true only while ≥1 device is bound", async () => {
    const input = new FakeInput("a", "A", "acme");
    const access = new FakeAccess([input]);
    const midi = new MidiTransport("all", fakeNav(access));
    expect(midi.active()).toBe(false); // access not yet acquired
    await flush();
    expect(midi.active()).toBe(true);

    access.statechange(() => access.inputs.delete("a")); // unplug the only device
    expect(midi.active()).toBe(false);
  });

  test("onStatusChange fires on bind and on the drop to zero", async () => {
    const input = new FakeInput("a", "A", "acme");
    const access = new FakeAccess([input]);
    const midi = new MidiTransport("all", fakeNav(access));
    const onChange = vi.fn();
    midi.onStatusChange(onChange);

    await flush(); // reconcile binds → false → true
    expect(onChange).toHaveBeenCalledTimes(1);

    midi.detach(); // close clears inputs → true → false
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("active is false once detached", async () => {
    const input = new FakeInput("a", "A", "acme");
    const access = new FakeAccess([input]);
    const midi = new MidiTransport("all", fakeNav(access));
    await flush();
    midi.detach();
    expect(midi.active()).toBe(false);
  });

  test("routes a Control-Change on channel 15 to the matching handler", async () => {
    const input = new FakeInput("a", "A", "acme");
    const access = new FakeAccess([input]);
    const midi = new MidiTransport("all", fakeNav(access));
    await flush();

    const handler = vi.fn();
    midi.acceptPlugin(fakePlugin(0x42, handler)); // CC controller 0x42 → plugin

    // status 0xBF = Control-Change (0xB) on channel 15 (0xF); val high nibble 0
    // selects ordinal 0, low nibble 7 is the payload.
    input.emit([0xbf, 0x42, 0x07]);
    expect(handler).toHaveBeenCalledWith({ event: "", data: "7" });
  });
});
