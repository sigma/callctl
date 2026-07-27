import type { SelectorConfig } from "@callctl/protocol";
import { loadConfig, type MidiDevices, type TransportConfig, wsPort } from "./config.js";
import { selectors } from "./meet/selectors.js";
import { loadPlugins } from "./plugins/index.js";
import { MidiTransport } from "./transport/midi-transport.js";
import { TransportId, TransportRegistry } from "./transport/transport-registry.js";
import { WSTransport } from "./transport/ws-transport.js";
import { mountWidget, NO_MIDI_INPUTS, webMidiInputSource } from "./widget/widget.js";

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

    // The port and enable-flags live in the versioned `config` envelope owned by
    // `config.ts` (#7); `loadConfig` also migrates a legacy `{ port }` install on
    // first read.
    const config = await loadConfig(local);

    // The registry owns the fan-out (replacing the static `MultiProtocol`) and
    // each transport's lifecycle. Both transports are config-driven: bound only
    // when their `enabled` flag is set (#13 moved WS off its old unconditional
    // enable so a Stream Deck toggle survives a Meet-tab reload). WS dials the
    // effective `wsPort` (plugin port, or the dev-bridge proxy when that's on,
    // #6); MIDI binds only the selected device set (#5). Defaults (both on, MIDI
    // `"all"`) preserve today's always-on behavior.
    const registry = new TransportRegistry(plugins);
    if (config.ws.enabled) {
      registry.enable(TransportId.WS, () => new WSTransport(wsPort(config)));
    }
    if (config.midi.enabled) {
      registry.enable(TransportId.MIDI, () => new MidiTransport(config.midi.devices));
    }

    // The Options page / widget writes the whole `config` envelope; we react to
    // that one key and apply each transport's changes live, no tab reload. This
    // is the *single* place config becomes registry calls — the widget (#13)
    // only ever writes config, so all four controls land here:
    //  - Stream Deck toggle (#13) → enable/disable ws (build/detach the socket),
    //  - ws port change (#7) / dev-bridge toggle (#6) → live `retarget` to the
    //    effective `wsPort` (redial, plugins intact; no-ops if unchanged),
    //  - MIDI master toggle (#5) → enable/disable (build/detach the transport),
    //  - MIDI device re-select (#5/#13) → live `retarget` (re-bind the inputs).
    onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !("config" in changes)) {
        return;
      }
      const next = changes.config.newValue as TransportConfig | undefined;
      if (next === undefined) {
        return;
      }

      if (next.ws.enabled) {
        // Idempotent: turns ws on, or leaves it for the following `retarget`.
        registry.enable(TransportId.WS, () => new WSTransport(wsPort(next)));
        registry.retarget<number>(TransportId.WS, wsPort(next));
      } else {
        registry.disable(TransportId.WS);
      }

      if (next.midi.enabled) {
        // `enable` is idempotent, so this both turns MIDI on and, when it was
        // already live, leaves it for the following device-set `retarget`.
        registry.enable(TransportId.MIDI, () => new MidiTransport(next.midi.devices));
        registry.retarget<MidiDevices>(TransportId.MIDI, next.midi.devices);
      } else {
        registry.disable(TransportId.MIDI);
      }
    });

    // The in-Meet control widget (#13). It only ever writes the `config`
    // envelope; the reactive listener above is what turns those writes into the
    // registry calls, so the widget needs no registry reference. Its MIDI
    // checklist wants the connected inputs — hand it Web MIDI access, or an
    // empty source if the browser denies/omits it, so the widget still mounts.
    const midiSource = await webMidiInputSource().catch(() => NO_MIDI_INPUTS);
    mountWidget({ local, onChanged, midi: midiSource });
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
