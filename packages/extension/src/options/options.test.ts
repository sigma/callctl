import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultConfig, type TransportConfig } from "../config.js";

/**
 * Options page against a jsdom form and an in-memory `chrome.storage.local`.
 * The behaviors that matter: both ports round-trip, a save preserves the
 * transport settings the page doesn't render, and an external `config` write
 * (the widget) re-populates the open fields via `onChanged`.
 */

type Listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

function fakeStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  const local = {
    get(keys: string[], cb: (items: Record<string, unknown>) => void): void {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in store) out[key] = store[key];
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

  const listeners: Listener[] = [];
  const onChanged = {
    addListener: (l: Listener) => listeners.push(l),
  } as unknown as typeof chrome.storage.onChanged;
  const emit = (changes: Record<string, chrome.storage.StorageChange>, area = "local") => {
    for (const l of listeners) l(changes, area);
  };
  return { local, store, onChanged, emit };
}

function buildForm(): Document {
  document.body.innerHTML = `
    <input type="number" id="port" />
    <input type="number" id="dev-bridge-port" />
    <div id="status"></div>
    <button id="save">Save</button>`;
  return document;
}

// `options.ts` runs `installOptions()` on import (touching `chrome`), so stub a
// global before importing it; the tests drive the exported functions directly.
let installOptions: typeof import("./options.js").installOptions;
let restoreOptions: typeof import("./options.js").restoreOptions;
let saveOptions: typeof import("./options.js").saveOptions;

beforeEach(async () => {
  vi.stubGlobal("chrome", {
    storage: {
      local: fakeStorage().local,
      onChanged: { addListener: () => {} },
    },
  });
  const mod = await import("./options.js");
  ({ installOptions, restoreOptions, saveOptions } = mod);
  buildForm();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("restoreOptions", () => {
  test("populates both port fields from the migrated config", async () => {
    const { local } = fakeStorage({ port: 1234 });
    const doc = buildForm();
    await restoreOptions(doc, local);
    expect((doc.getElementById("port") as HTMLInputElement).value).toBe("1234");
    expect((doc.getElementById("dev-bridge-port") as HTMLInputElement).value).toBe("2396");
  });
});

describe("saveOptions", () => {
  test("writes both ports, preserving settings the page doesn't render", async () => {
    const existing: TransportConfig = {
      ...defaultConfig(1111),
      midi: { enabled: false, devices: [{ id: "a", name: "Pad", manufacturer: "Acme" }] },
    };
    const { local, store } = fakeStorage({ config: existing });
    const doc = buildForm();
    (doc.getElementById("port") as HTMLInputElement).value = "3000";
    (doc.getElementById("dev-bridge-port") as HTMLInputElement).value = "3001";

    await saveOptions(doc, local);

    const saved = store.config as TransportConfig;
    expect(saved.ws.port).toBe(3000);
    expect(saved.ws.devBridge.port).toBe(3001);
    expect(saved.midi).toEqual(existing.midi); // untouched
  });

  test("ignores a non-numeric field rather than persisting NaN", async () => {
    const { local, store } = fakeStorage();
    const doc = buildForm();
    (doc.getElementById("port") as HTMLInputElement).value = "not-a-port";
    (doc.getElementById("dev-bridge-port") as HTMLInputElement).value = "3001";

    await saveOptions(doc, local);
    expect(store.config).toBeUndefined();
  });
});

describe("installOptions onChanged sync", () => {
  test("re-populates fields when `config` is written elsewhere", async () => {
    const { local, onChanged, emit } = fakeStorage();
    const doc = buildForm();
    installOptions(doc, local, onChanged);

    const next = defaultConfig(7000);
    next.ws.devBridge.port = 7001;
    emit({ config: { newValue: next, oldValue: undefined } });

    expect((doc.getElementById("port") as HTMLInputElement).value).toBe("7000");
    expect((doc.getElementById("dev-bridge-port") as HTMLInputElement).value).toBe("7001");
  });

  test("ignores changes to other keys (e.g. selectors)", async () => {
    const { local, onChanged, emit } = fakeStorage();
    const doc = buildForm();
    (doc.getElementById("port") as HTMLInputElement).value = "2395";
    installOptions(doc, local, onChanged);

    emit({ selectors: { newValue: { mute: "Mute" }, oldValue: undefined } });
    expect((doc.getElementById("port") as HTMLInputElement).value).toBe("2395"); // unchanged
  });
});
