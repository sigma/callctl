import { DEFAULT_PORT } from "@callctl/protocol";

/**
 * The persisted transport configuration (T1 schema, decided in issue #2).
 *
 * A single versioned `config` key in `chrome.storage.local`, grouped by
 * transport so each transport owns all of its settings. `selectors` remains its
 * own untouched top-level key. Ports and MIDI device ids are machine-specific,
 * so `local` (never `sync`) is correct.
 *
 * The nested envelope leaves a natural home for the deliberately out-of-scope
 * MIDI channel/CC/message mapping (it slots under `midi` later as e.g.
 * `mapping`) without a schema rewrite.
 *
 * This module is the shared read/write/migrate layer: the Options page and the
 * transport lifecycle (issue #10) both go through `loadConfig`/`saveConfig`
 * rather than touching the raw storage key.
 */

/** Default dev-bridge proxy port the ws client dials in dev-bridge mode. */
export const DEFAULT_DEV_BRIDGE_PORT = 2396;

/** The only schema version so far; bump + transform in `loadConfig` to migrate. */
export const CONFIG_VERSION = 1;

/** Storage key holding the whole config envelope. */
const CONFIG_KEY = "config";

/** Legacy top-level key the very first extension shipped: just the ws port. */
const LEGACY_PORT_KEY = "port";

/**
 * How a selected MIDI input is remembered across replugs/restarts. Matched
 * id-primary with a name+manufacturer fallback (see issue #2); `id` is the Web
 * MIDI `MIDIInput.id`, which is not stable across replugs, hence the fallback.
 */
export type MidiDeviceRef = { id: string; name: string; manufacturer: string };

/**
 * Which MIDI inputs a transport binds: the `"all"` sentinel meaning "every
 * connected input", or an explicit set of selected-device refs. This is the
 * per-transport `retarget` config for {@link MidiTransport}.
 */
export type MidiDevices = "all" | MidiDeviceRef[];

export type TransportConfig = {
  version: typeof CONFIG_VERSION;
  ws: {
    enabled: boolean;
    port: number;
    devBridge: {
      enabled: boolean;
      port: number;
    };
  };
  midi: {
    enabled: boolean;
    /** `"all"` is a first-class mode meaning "every connected input". */
    devices: MidiDevices;
  };
};

/**
 * A fresh config. `port` is threaded in so migration can preserve a legacy
 * install's port; fresh installs get `DEFAULT_PORT`. Defaults match today's
 * behavior: ws on, dev-bridge off, MIDI on listening to every input.
 */
export function defaultConfig(port: number = DEFAULT_PORT): TransportConfig {
  return {
    version: CONFIG_VERSION,
    ws: {
      enabled: true,
      port,
      devBridge: { enabled: false, port: DEFAULT_DEV_BRIDGE_PORT },
    },
    midi: { enabled: true, devices: "all" },
  };
}

/**
 * The port the ws client should dial. Dev-bridge mode re-points it at the
 * bridge's proxy port; otherwise it dials the plugin port directly. This is the
 * whole port-selection decision behind the live dev-bridge switch (#6): flipping
 * `ws.devBridge.enabled` and re-reading this feeds a transparent
 * `WSTransport.retarget` — a redial of the new port with plugins intact, no tab
 * reload. Dev-bridge is a ws-only concept, so MIDI never consults this.
 */
export function wsPort(config: TransportConfig): number {
  return config.ws.devBridge.enabled ? config.ws.devBridge.port : config.ws.port;
}

function get<T>(local: chrome.storage.LocalStorageArea, keys: string[]): Promise<Partial<T>> {
  return new Promise((resolve) => {
    local.get(keys, (items) => resolve(items as Partial<T>));
  });
}

function set(
  local: chrome.storage.LocalStorageArea,
  items: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    local.set(items, () => resolve());
  });
}

function remove(local: chrome.storage.LocalStorageArea, key: string): Promise<void> {
  return new Promise((resolve) => {
    local.remove(key, () => resolve());
  });
}

/**
 * Read the config, migrating a live install on the way. If a `config` envelope
 * already exists it is returned as-is (future version bumps transform here). If
 * it is absent — a fresh install or a pre-schema legacy install — one is
 * synthesized (preserving the legacy `port` if present), persisted, and the
 * legacy `port` key is deleted so the migration runs exactly once.
 */
export async function loadConfig(
  local: chrome.storage.LocalStorageArea = chrome.storage.local,
): Promise<TransportConfig> {
  const stored = await get<{ config: TransportConfig; port: number }>(local, [
    CONFIG_KEY,
    LEGACY_PORT_KEY,
  ]);

  if (stored.config !== undefined) {
    return stored.config;
  }

  const config = defaultConfig(stored.port ?? DEFAULT_PORT);
  await set(local, { [CONFIG_KEY]: config });
  if (stored.port !== undefined) {
    await remove(local, LEGACY_PORT_KEY);
  }
  return config;
}

/** Persist the whole config envelope, replacing what was there. */
export async function saveConfig(
  local: chrome.storage.LocalStorageArea,
  config: TransportConfig,
): Promise<void> {
  await set(local, { [CONFIG_KEY]: config });
}
