import type { SelectorConfig } from "@callctl/protocol";
import { loadConfig, type TransportConfig } from "./config.js";
import { selectors } from "./meet/selectors.js";
import { loadPlugins } from "./plugins/index.js";
import { MidiTransport } from "./transport/midi-transport.js";
import { TransportId, TransportRegistry } from "./transport/transport-registry.js";
import { WSTransport } from "./transport/ws-transport.js";

/**
 * The extension's beating heart. Contrary to a common misreading of this
 * project, the functional bridge runs **here in the content script**, not in
 * the background page/service worker — the content script lives as long as the
 * Meet tab, giving the websocket reconnect loop and the `MutationObserver`s a
 * persistent home. (The MV2 `background.ts` only ever logged; that is preserved
 * as a thin MV3 service worker.)
 */

function init(
  local: chrome.storage.LocalStorageArea,
  onChanged: typeof chrome.storage.onChanged,
): void {
  local.get<{ selectors: Partial<SelectorConfig> }>({ selectors: {} }, async (result) => {
    // Overlay any selector overrides fixed in a previous session (or pushed
    // over the wire and persisted) before the plugins' models start reading.
    selectors.apply(result.selectors ?? {});
    const plugins = loadPlugins({
      persistSelectors: (config) => local.set({ selectors: config }),
    });

    // The port (and, later, enable-flags) live in the versioned `config`
    // envelope owned by `config.ts` (#7); `loadConfig` also migrates a legacy
    // `{ port }` install on first read.
    const config = await loadConfig(local);

    // The registry owns the fan-out (replacing the static `MultiProtocol`) and
    // each transport's lifecycle. Enable WS + MIDI up front to preserve today's
    // always-on behavior; the widget (#4) will drive enable/disable from the
    // persisted `config.*.enabled` flags later.
    const registry = new TransportRegistry(plugins);
    registry.enable(TransportId.WS, () => new WSTransport(config.ws.port));
    registry.enable(TransportId.MIDI, () => new MidiTransport());

    // A port change (from the Options page, #7) is now a live retarget: the ws
    // redials the new port with its plugins intact, no tab reload. The Options
    // page writes the whole `config` envelope, so we react to that key and
    // retarget to the current ws port — `retarget` no-ops if it's unchanged.
    onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && "config" in changes) {
        const next = changes.config.newValue as TransportConfig | undefined;
        if (next !== undefined) {
          registry.retarget<number>(TransportId.WS, next.ws.port);
        }
      }
    });
  });
}

function ready(doc: Document, callback: () => void): void {
  if (doc.readyState !== "loading") {
    callback();
  } else {
    doc.addEventListener("DOMContentLoaded", callback);
  }
}

ready(document, () => {
  init(chrome.storage.local, chrome.storage.onChanged);
});
