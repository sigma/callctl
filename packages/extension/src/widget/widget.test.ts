import { afterEach, describe, expect, test } from "vitest";
import { defaultConfig, type MidiDeviceRef, type TransportConfig } from "../config.js";
import type { TransportStatus } from "../transport/transport-registry.js";
import {
  type MidiInputInfo,
  type MidiInputSource,
  mountWidget,
  type TransportStatusSource,
  type TransportWidget,
  type WidgetDeps,
} from "./widget.js";

/**
 * The widget against jsdom + an in-memory `chrome.storage.local` whose `set`
 * emits `onChanged` (as real chrome does), so the save → repaint round-trip is
 * exercised end to end. The behaviors that matter: initial paint reflects the
 * persisted config; each toggle read-modify-writes exactly its own slice of the
 * envelope; the MIDI checklist materializes an explicit device list that
 * preserves absent selections; an external `config` write repaints; and the
 * self-owned host survives Meet detaching it.
 */

type Listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

function fakeStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  const listeners: Listener[] = [];
  const local = {
    get(keys: string[], cb: (items: Record<string, unknown>) => void): void {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in store) out[key] = store[key];
      }
      cb(out);
    },
    set(items: Record<string, unknown>, cb: () => void): void {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = { oldValue: store[key], newValue };
        store[key] = newValue;
      }
      cb();
      for (const l of listeners) l(changes, "local");
    },
    remove(key: string, cb: () => void): void {
      delete store[key];
      cb();
    },
  } as unknown as chrome.storage.LocalStorageArea;

  const onChanged = {
    addListener: (l: Listener) => listeners.push(l),
    removeListener: (l: Listener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as typeof chrome.storage.onChanged;

  const emit = (changes: Record<string, chrome.storage.StorageChange>, area = "local") => {
    for (const l of listeners) l(changes, area);
  };
  return { local, store, onChanged, emit };
}

function fakeMidi(initial: MidiInputInfo[] = []) {
  let inputs = initial;
  const subs: (() => void)[] = [];
  const source: MidiInputSource = {
    list: () => inputs,
    subscribe: (cb) => {
      subs.push(cb);
      return () => {};
    },
  };
  const setInputs = (next: MidiInputInfo[]) => {
    inputs = next;
    for (const cb of subs) cb();
  };
  return { source, setInputs };
}

function fakeStatus(initial: TransportStatus = {}) {
  let snap = initial;
  const subs: (() => void)[] = [];
  const source: TransportStatusSource = {
    snapshot: () => snap,
    subscribe: (cb) => {
      subs.push(cb);
      return () => {};
    },
  };
  const set = (next: TransportStatus) => {
    snap = next;
    for (const cb of subs) cb();
  };
  return { source, set };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Every mounted widget is tracked and torn down in afterEach: an undisposed
// widget keeps a live survival-observer that would re-append its host after we
// remove it, leaking stale hosts into the next test.
const mounted: TransportWidget[] = [];
function mount(deps: WidgetDeps): TransportWidget {
  const widget = mountWidget(deps);
  mounted.push(widget);
  return widget;
}

function shadow(): ShadowRoot {
  const host = document.getElementById("callctl-widget-host");
  if (host?.shadowRoot == null) throw new Error("widget host not mounted");
  return host.shadowRoot;
}

const rows = () => shadow().querySelectorAll<HTMLInputElement>(".row .sw input");
const sdBox = () => rows()[0];
const devBox = () => rows()[1];
const midiBox = () => rows()[2];
const midiChecks = () => [...shadow().querySelectorAll<HTMLInputElement>(".midiList label input")];
// Live dots ride only on the two real transport rows (Stream Deck, then MIDI).
const dots = () => [...shadow().querySelectorAll<HTMLElement>(".row .dot")];
const sdDot = () => dots()[0];
const midiDot = () => dots()[1];
const card = () => shadow().querySelector<HTMLElement>(".card");

afterEach(() => {
  for (const widget of mounted.splice(0)) widget.destroy();
  for (const host of [...document.querySelectorAll("#callctl-widget-host")]) host.remove();
  document.body.innerHTML = "";
});

describe("mount + initial paint", () => {
  test("mounts a shadow host on <html> and reflects the persisted config", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    const { source } = fakeMidi([{ id: "a", name: "APC", manufacturer: "Akai" }]);
    mount({ local, onChanged, midi: source });
    await flush();

    const host = document.getElementById("callctl-widget-host");
    expect(host?.parentElement).toBe(document.documentElement);
    expect(sdBox().checked).toBe(true);
    expect(devBox().checked).toBe(false); // dev-bridge off by default
    expect(midiBox().checked).toBe(true);
    // "all" → every connected input renders checked
    expect(midiChecks().map((b) => b.checked)).toEqual([true]);
  });

  test("a disabled ws flag paints the Stream Deck toggle off", async () => {
    const config: TransportConfig = {
      ...defaultConfig(2395),
      ws: { ...defaultConfig().ws, enabled: false },
    };
    const { local, onChanged } = fakeStorage({ config });
    mount({ local, onChanged });
    await flush();
    expect(sdBox().checked).toBe(false);
  });
});

describe("toggles read-modify-write only their own slice", () => {
  test("Stream Deck toggle writes ws.enabled, preserving the rest", async () => {
    const { local, onChanged, store } = fakeStorage({ config: defaultConfig(2395) });
    mount({ local, onChanged });
    await flush();

    sdBox().click(); // true → false
    await flush();

    const saved = store.config as TransportConfig;
    expect(saved.ws.enabled).toBe(false);
    expect(saved.ws.port).toBe(2395);
    expect(saved.midi).toEqual(defaultConfig().midi);
    // round-trip repaint keeps the DOM in sync
    expect(sdBox().checked).toBe(false);
  });

  test("Dev-bridge toggle writes ws.devBridge.enabled", async () => {
    const { local, onChanged, store } = fakeStorage({ config: defaultConfig(2395) });
    mount({ local, onChanged });
    await flush();

    devBox().click(); // false → true
    await flush();
    expect((store.config as TransportConfig).ws.devBridge.enabled).toBe(true);
  });

  test("MIDI toggle writes midi.enabled and disables the checklist when off", async () => {
    const { local, onChanged, store } = fakeStorage({ config: defaultConfig(2395) });
    const { source } = fakeMidi([{ id: "a", name: "APC", manufacturer: "Akai" }]);
    mount({ local, onChanged, midi: source });
    await flush();

    midiBox().click(); // true → false
    await flush();
    expect((store.config as TransportConfig).midi.enabled).toBe(false);
    expect(midiChecks()[0].disabled).toBe(true);
  });
});

describe("MIDI device checklist", () => {
  test('unchecking one input under "all" materializes the remaining inputs', async () => {
    const inputs = [
      { id: "a", name: "APC", manufacturer: "Akai" },
      { id: "b", name: "Launchkey", manufacturer: "Novation" },
    ];
    const { local, onChanged, store } = fakeStorage({ config: defaultConfig(2395) });
    const { source } = fakeMidi(inputs);
    mount({ local, onChanged, midi: source });
    await flush();

    midiChecks()[0].click(); // uncheck APC
    await flush();

    const devices = (store.config as TransportConfig).midi.devices as MidiDeviceRef[];
    expect(devices).toEqual([{ id: "b", name: "Launchkey", manufacturer: "Novation" }]);
  });

  test("preserves a selected device that is not currently connected", async () => {
    const absent: MidiDeviceRef = { id: "z", name: "Offline", manufacturer: "Ghost" };
    const connected = { id: "a", name: "APC", manufacturer: "Akai" };
    const config: TransportConfig = {
      ...defaultConfig(2395),
      midi: { enabled: true, devices: [absent, { id: "a", name: "APC", manufacturer: "Akai" }] },
    };
    const { local, onChanged, store } = fakeStorage({ config });
    const { source } = fakeMidi([connected]);
    mount({ local, onChanged, midi: source });
    await flush();

    // APC is currently checked (matched); uncheck it.
    midiChecks()[0].click();
    await flush();

    const devices = (store.config as TransportConfig).midi.devices as MidiDeviceRef[];
    expect(devices).toEqual([absent]); // absent one kept, APC dropped
  });

  test("repaints the checklist on a MIDI hotplug", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    const { source, setInputs } = fakeMidi([]);
    mount({ local, onChanged, midi: source });
    await flush();
    expect(midiChecks()).toHaveLength(0);

    setInputs([{ id: "a", name: "APC", manufacturer: "Akai" }]);
    await flush();
    expect(midiChecks()).toHaveLength(1);
  });
});

describe("live transport status dots + pill tint", () => {
  test("only the Stream Deck and MIDI rows carry a dot", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    mount({ local, onChanged, status: fakeStatus().source });
    await flush();
    expect(dots()).toHaveLength(2); // dev-bridge row has none
  });

  test("a disabled transport shows no dot; enabled+active is green; enabled+inactive is amber", async () => {
    const config: TransportConfig = {
      ...defaultConfig(2395),
      ws: { ...defaultConfig().ws, enabled: true }, // active below
      midi: { enabled: false, devices: "all" }, // disabled → hidden
    };
    const { local, onChanged } = fakeStorage({ config });
    // ws enabled + not in snapshot (not connected) → amber; midi disabled → hidden.
    mount({ local, onChanged, status: fakeStatus({}).source });
    await flush();
    expect(sdDot().className).toBe("dot stale");
    expect(midiDot().className).toBe("dot hidden");
  });

  test("an active enabled transport paints green", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    mount({ local, onChanged, status: fakeStatus({ ws: true, midi: true }).source });
    await flush();
    expect(sdDot().className).toBe("dot live");
    expect(midiDot().className).toBe("dot live");
  });

  test("a status change repaints the dot live without a config write", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    const status = fakeStatus({ ws: false, midi: false });
    mount({ local, onChanged, status: status.source });
    await flush();
    expect(sdDot().className).toBe("dot stale");

    status.set({ ws: true, midi: false }); // ws just connected
    expect(sdDot().className).toBe("dot live");
  });

  test("the pill tints amber (.warn) exactly when an enabled transport is inactive", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    const status = fakeStatus({ ws: false, midi: false });
    mount({ local, onChanged, status: status.source });
    await flush();
    expect(card()?.classList.contains("warn")).toBe(true);

    status.set({ ws: true, midi: true }); // all live now
    expect(card()?.classList.contains("warn")).toBe(false);
  });
});

describe("external config writes + survival + teardown", () => {
  test("an external `config` write repaints the toggles", async () => {
    const { local, onChanged, emit } = fakeStorage({ config: defaultConfig(2395) });
    mount({ local, onChanged });
    await flush();
    expect(sdBox().checked).toBe(true);

    const next: TransportConfig = {
      ...defaultConfig(2395),
      ws: { ...defaultConfig().ws, enabled: false },
    };
    emit({ config: { oldValue: defaultConfig(2395), newValue: next } });
    expect(sdBox().checked).toBe(false);
  });

  test("re-appends the host if Meet detaches it", async () => {
    const { local, onChanged } = fakeStorage({ config: defaultConfig(2395) });
    mount({ local, onChanged });
    await flush();

    const host = document.getElementById("callctl-widget-host");
    host?.remove();
    expect(host?.isConnected).toBe(false);

    await flush(); // observer microtask re-appends
    expect(host?.isConnected).toBe(true);
  });

  test("destroy removes the host and stops reacting to config writes", async () => {
    const { local, onChanged, emit } = fakeStorage({ config: defaultConfig(2395) });
    const widget = mount({ local, onChanged });
    await flush();

    widget.destroy();
    expect(document.getElementById("callctl-widget-host")).toBeNull();

    // A later write must not throw or resurrect anything.
    const next: TransportConfig = {
      ...defaultConfig(2395),
      ws: { ...defaultConfig().ws, enabled: false },
    };
    emit({ config: { oldValue: defaultConfig(2395), newValue: next } });
    await flush();
    expect(document.getElementById("callctl-widget-host")).toBeNull();
  });
});
