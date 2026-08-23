import { loadConfig, type MidiDevices, type TransportConfig, wsPort } from "./config.js";
import type { SurfacePlugin } from "./plugin.js";
import { MidiTransport } from "./transport/midi-transport.js";
import { TransportId, TransportRegistry } from "./transport/transport-registry.js";
import { WSTransport } from "./transport/ws-transport.js";

/**
 * The surface-agnostic half of starting a content script.
 *
 * Every surface — Meet today, Chat next — has to load the config envelope,
 * build a {@link TransportRegistry} over its plugin set, enable the transports
 * it wants, and keep reacting to live config edits. None of that mentions Meet.
 * Owning it here means the next config option cannot be added to one content
 * script and forgotten in the other (ADR 0002).
 *
 * What stays with the surface is what is genuinely surface-specific: which
 * plugins to build, any pre-load its models need (Meet overlays its persisted
 * selectors first), and whatever UI it mounts afterwards.
 */
export interface BootstrapOptions {
  local: chrome.storage.LocalStorageArea;
  onChanged: typeof chrome.storage.onChanged;

  /** This surface's plugin set, already constructed. */
  plugins: SurfacePlugin[];

  /**
   * Bind the MIDI transport too. **Meet-only.** If both content scripts bound
   * MIDI they would both receive every CC message while sharing one global
   * plugin-CC namespace with no coordination (ADR 0002), so Chat leaves this
   * off and runs ws-only.
   */
  midi: boolean;
}

/**
 * Load config, wire the transports, and keep them in step with live config
 * changes. Returns the registry so a surface can hand out a read-only status
 * port (the Meet widget's live dots) — never the enable/disable handles.
 */
export async function bootstrap(options: BootstrapOptions): Promise<TransportRegistry> {
  const { local, onChanged, plugins, midi } = options;

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
  if (midi && config.midi.enabled) {
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

    // A surface that does not bind MIDI ignores the MIDI half of the envelope
    // entirely — the `config` key is one shared store, so the toggle governs
    // only the surfaces that asked for MIDI.
    if (!midi) {
      return;
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

  return registry;
}
