import { DEFAULT_PORT } from "@callctl/protocol";
import { describe, expect, test } from "vitest";
import {
  CONFIG_VERSION,
  DEFAULT_DEV_BRIDGE_PORT,
  defaultConfig,
  loadConfig,
  matchesMidiDevice,
  saveConfig,
  type TransportConfig,
  wsPort,
} from "./config.js";

/**
 * The config module is the shared read/write/migrate layer for the T1 schema
 * (issue #2). The headline behaviors are: a legacy `{ port }` install migrates
 * once (preserving the port, deleting the legacy key) and an existing envelope
 * is never clobbered.
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

describe("defaultConfig", () => {
  test("matches today's behavior: ws on, dev-bridge off, MIDI listening to all", () => {
    expect(defaultConfig()).toEqual<TransportConfig>({
      version: CONFIG_VERSION,
      ws: {
        enabled: true,
        port: DEFAULT_PORT,
        devBridge: { enabled: false, port: DEFAULT_DEV_BRIDGE_PORT },
      },
      midi: { enabled: true, devices: "all" },
    });
  });

  test("threads a custom ws port through", () => {
    expect(defaultConfig(9999).ws.port).toBe(9999);
  });
});

describe("loadConfig", () => {
  test("fresh install synthesizes and persists the defaults", async () => {
    const { local, store } = fakeStorage();
    const config = await loadConfig(local);
    expect(config).toEqual(defaultConfig());
    expect(store.config).toEqual(defaultConfig());
  });

  test("migrates a legacy { port } install, preserving the port and deleting the legacy key", async () => {
    const { local, store } = fakeStorage({ port: 1234 });
    const config = await loadConfig(local);
    expect(config.ws.port).toBe(1234);
    expect(config.ws.devBridge.port).toBe(DEFAULT_DEV_BRIDGE_PORT);
    expect(store.config).toEqual(defaultConfig(1234));
    expect("port" in store).toBe(false);
  });

  test("leaves an existing envelope untouched (no clobber, no re-migrate)", async () => {
    const existing: TransportConfig = {
      ...defaultConfig(5555),
      midi: { enabled: false, devices: [{ id: "a", name: "Pad", manufacturer: "Acme" }] },
    };
    const { local, store } = fakeStorage({ config: existing });
    const config = await loadConfig(local);
    expect(config).toEqual(existing);
    expect(store.config).toEqual(existing);
  });

  test("does not touch the separate `selectors` key while migrating", async () => {
    const { local, store } = fakeStorage({ port: 1234, selectors: { mute: "Mute" } });
    await loadConfig(local);
    expect(store.selectors).toEqual({ mute: "Mute" });
  });
});

describe("wsPort", () => {
  test("dials the plugin port when dev-bridge is off", () => {
    expect(wsPort(defaultConfig(5555))).toBe(5555);
  });

  test("re-points to the dev-bridge port when dev-bridge is on", () => {
    const config: TransportConfig = {
      ...defaultConfig(5555),
      ws: {
        enabled: true,
        port: 5555,
        devBridge: { enabled: true, port: 2396 },
      },
    };
    expect(wsPort(config)).toBe(2396);
  });
});

describe("matchesMidiDevice", () => {
  const ref = { id: "abc", name: "APC mini", manufacturer: "Akai" };

  test("matches on id first, whatever the name/manufacturer", () => {
    expect(matchesMidiDevice({ id: "abc", name: "renamed", manufacturer: "x" }, ref)).toBe(true);
  });

  test("falls back to name+manufacturer when the id has drifted", () => {
    expect(matchesMidiDevice({ id: "new-id", name: "APC mini", manufacturer: "Akai" }, ref)).toBe(
      true,
    );
  });

  test("does not match on a partial fallback or when fields are absent", () => {
    expect(matchesMidiDevice({ id: "x", name: "APC mini", manufacturer: "Other" }, ref)).toBe(
      false,
    );
    expect(matchesMidiDevice({ id: "x", name: null, manufacturer: null }, ref)).toBe(false);
  });
});

describe("saveConfig", () => {
  test("round-trips through storage", async () => {
    const { local } = fakeStorage();
    const config = defaultConfig(4242);
    await saveConfig(local, config);
    expect(await loadConfig(local)).toEqual(config);
  });
});
