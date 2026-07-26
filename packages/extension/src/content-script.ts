import { DEFAULT_PORT, type SelectorConfig } from "@meetdeck/protocol";
import { App } from "./app.js";
import { selectors } from "./meet/selectors.js";
import { loadPlugins } from "./plugins/index.js";
import { MidiProtocol } from "./transport/midi-protocol.js";
import { MultiProtocol } from "./transport/multi-protocol.js";
import { WSProtocol } from "./transport/ws-protocol.js";

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
  local.get<{ port: number; selectors: Partial<SelectorConfig> }>(
    { port: DEFAULT_PORT, selectors: {} },
    (result) => {
      // Overlay any selector overrides fixed in a previous session (or pushed
      // over the wire and persisted) before the plugins' models start reading.
      selectors.apply(result.selectors ?? {});
      const plugins = loadPlugins({
        persistSelectors: (config) => local.set({ selectors: config }),
      });

      const transport = new MultiProtocol([new WSProtocol(result.port), new MidiProtocol()]);

      // Changing the port tears the bridge down; the user reloads the Meet tab
      // to pick up the new value. (Same limitation as the legacy extension.)
      onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && "port" in changes) {
          transport.shutdown();
        }
      });

      new App(transport).run(plugins);
    },
  );
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
