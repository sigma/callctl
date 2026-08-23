import { describe, expect, test, vi } from "vitest";
import { bootstrap } from "./bootstrap.js";
import { defaultConfig, type TransportConfig } from "./config.js";
import type { SurfacePlugin } from "./plugin.js";
import { TransportId } from "./transport/transport-registry.js";

/**
 * `bootstrap` is the single place config becomes transport-registry calls
 * (ADR 0002), so these tests pin exactly that: which transports a surface ends
 * up with, and that a live `config` write still moves them. Neither transport
 * is real here — jsdom has no Web MIDI, and a `WSTransport` would start dialling
 * — so we assert on `registry.isEnabled`, the observable outcome, rather than on
 * either socket.
 */

/** Minimal in-memory stand-in for `chrome.storage.local` (keys-array `get`). */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  const local = {
    get(keys: string[], cb: (items: Record<string, unknown>) => void): void {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in store) {
          out[key] = store[key];
        }
      }
      cb(out);
    },
    set(items: Record<string, unknown>, cb: () => void): void {
      Object.assign(store, items);
      cb();
    },
    remove(key: string, cb: () => void): void {
      delete store[key];
      cb();
    },
  } as unknown as chrome.storage.LocalStorageArea;
  return { local, store };
}

/**
 * A stand-in for `chrome.storage.onChanged` that lets a test fire the change
 * the Options page / widget would have written.
 */
function fakeOnChanged() {
  const listeners: ((
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void)[] = [];
  const onChanged = {
    addListener(l: (typeof listeners)[number]): void {
      listeners.push(l);
    },
  } as unknown as typeof chrome.storage.onChanged;
  const write = (config: TransportConfig): void => {
    for (const l of listeners) {
      l({ config: { newValue: config } as chrome.storage.StorageChange }, "local");
    }
  };
  return { onChanged, write };
}

const noPlugins: SurfacePlugin[] = [];

/** A stand-in session: the handshake fields a real surface would supply. */
const SESSION = () => ({ id: "test-client", surface: "test" });

/** Web MIDI does not exist in jsdom; `MidiTransport` swallows the rejection. */
function stubMidi(): void {
  vi.stubGlobal("navigator", {
    ...navigator,
    requestMIDIAccess: () => Promise.reject(new Error("no MIDI in jsdom")),
  });
}

describe("bootstrap", () => {
  test("a MIDI-less surface binds ws only, even with MIDI enabled in config", async () => {
    const { local } = fakeStorage({ config: defaultConfig() });
    const { onChanged } = fakeOnChanged();

    const registry = await bootstrap({
      local,
      onChanged,
      plugins: noPlugins,
      midi: false,
      session: SESSION,
    });

    expect(registry.isEnabled(TransportId.WS)).toBe(true);
    expect(registry.isEnabled(TransportId.MIDI)).toBe(false);
    registry.disable(TransportId.WS);
  });

  test("a MIDI-bound surface binds both", async () => {
    stubMidi();
    const { local } = fakeStorage({ config: defaultConfig() });
    const { onChanged } = fakeOnChanged();

    const registry = await bootstrap({
      local,
      onChanged,
      plugins: noPlugins,
      midi: true,
      session: SESSION,
    });

    expect(registry.isEnabled(TransportId.WS)).toBe(true);
    expect(registry.isEnabled(TransportId.MIDI)).toBe(true);
    registry.disable(TransportId.WS);
    registry.disable(TransportId.MIDI);
  });

  test("a disabled ws flag leaves the socket unbound", async () => {
    const config = defaultConfig();
    config.ws.enabled = false;
    const { local } = fakeStorage({ config });
    const { onChanged } = fakeOnChanged();

    const registry = await bootstrap({
      local,
      onChanged,
      plugins: noPlugins,
      midi: false,
      session: SESSION,
    });

    expect(registry.isEnabled(TransportId.WS)).toBe(false);
  });

  test("a live config write turns ws off and back on", async () => {
    const { local } = fakeStorage({ config: defaultConfig() });
    const { onChanged, write } = fakeOnChanged();
    const registry = await bootstrap({
      local,
      onChanged,
      plugins: noPlugins,
      midi: false,
      session: SESSION,
    });

    const off = defaultConfig();
    off.ws.enabled = false;
    write(off);
    expect(registry.isEnabled(TransportId.WS)).toBe(false);

    write(defaultConfig());
    expect(registry.isEnabled(TransportId.WS)).toBe(true);
    registry.disable(TransportId.WS);
  });

  test("a MIDI-less surface ignores the MIDI half of a live config write", async () => {
    const { local } = fakeStorage({ config: defaultConfig() });
    const { onChanged, write } = fakeOnChanged();
    const registry = await bootstrap({
      local,
      onChanged,
      plugins: noPlugins,
      midi: false,
      session: SESSION,
    });

    write(defaultConfig()); // MIDI enabled in the envelope…
    expect(registry.isEnabled(TransportId.MIDI)).toBe(false); // …still not ours
    registry.disable(TransportId.WS);
  });
});
