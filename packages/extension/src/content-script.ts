import { bootstrap } from "./core/bootstrap.js";
import { loadClientId } from "./core/identity.js";
import { isMeetingUrl } from "./meet/location.js";
import { loadMeetSelectors, saveMeetSelectors } from "./meet/selector-storage.js";
import { selectors } from "./meet/selectors.js";
import { loadPlugins } from "./plugins/index.js";
import { mountWidget, NO_MIDI_INPUTS, webMidiInputSource } from "./widget/widget.js";

/**
 * The extension's beating heart, on the Meet surface. Contrary to a common
 * misreading of this project, the functional bridge runs **here in the content
 * script**, not in the background page/service worker — the content script
 * lives as long as the Meet tab, giving the websocket reconnect loop and the
 * `MutationObserver`s a persistent home. (The MV2 `background.ts` only ever
 * logged; that is preserved as a thin MV3 service worker.)
 *
 * Everything surface-agnostic — config, the transport registry, live config
 * reaction — belongs to `core/bootstrap.ts`. What is left here is exactly the
 * Meet-specific part: the persisted selector overlay, the Meet plugin set, MIDI
 * (Meet-only, see ADR 0002), and the in-call widget.
 */

async function init(
  local: chrome.storage.LocalStorageArea,
  onChanged: typeof chrome.storage.onChanged,
): Promise<void> {
  // Overlay any selector overrides fixed in a previous session (or pushed over
  // the wire and persisted) before the plugins' models start reading. The key
  // is Meet-scoped and migrates a pre-split install; see `selector-storage.ts`.
  selectors.apply(await loadMeetSelectors(local));
  const plugins = loadPlugins({
    persistSelectors: (config) => saveMeetSelectors(local, config),
  });

  // Identity is per extension install (ADR 0001); the surface name is coarse
  // and rides along for logs and UI only — routing reads the derived op set.
  const id = await loadClientId(local, "meet");
  const registry = await bootstrap({
    local,
    onChanged,
    plugins,
    midi: true,
    session: () => ({ id, surface: "meet" }),
  });

  // The in-Meet control widget (#13). It only ever writes the `config`
  // envelope; the reactive listener inside `bootstrap` is what turns those
  // writes into registry calls, so the widget needs no registry reference.
  // Its MIDI checklist wants the connected inputs — hand it Web MIDI access,
  // or an empty source if the browser denies/omits it, so it still mounts.
  const midiSource = await webMidiInputSource().catch(() => NO_MIDI_INPUTS);
  // Hand the widget a *narrow* read-only status port, not the registry itself
  // (#23): it can read liveness but has no enable/disable/retarget handle, so
  // the widget stays a pure config writer.
  mountWidget({
    local,
    onChanged,
    midi: midiSource,
    // The content script matches every meet.google.com/* page; only surface
    // the widget in an actual meeting room, not on landing/home.
    visibleWhen: isMeetingUrl,
    status: {
      snapshot: () => registry.snapshot(),
      subscribe: (onChange) => registry.subscribe(onChange),
    },
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
  init(chrome.storage.local, chrome.storage.onChanged).catch((err: unknown) => {
    console.error("callctl: Meet content script failed to start:", err);
  });
});
