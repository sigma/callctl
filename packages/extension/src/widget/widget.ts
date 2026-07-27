import {
  loadConfig,
  type MidiDeviceRef,
  type MidiDevices,
  matchesMidiDevice,
  saveConfig,
  type TransportConfig,
} from "../config.js";
import type { Disposer } from "../disposer.js";
import type { TransportStatus } from "../transport/transport-registry.js";
import { WIDGET_STYLE } from "./style.js";

/**
 * The in-Meet transport control widget (wayfinder map #1, ticket #13). A
 * floating card anchored top-centre that folds to a pill — Variant A, the shell
 * settled in #4.
 *
 * **It writes config, nothing else.** Every control read-modify-writes the
 * versioned `config` envelope (see `../config.ts`); the content script's single
 * reactive `onChanged` listener (issue #10) turns those writes into live
 * `TransportRegistry` calls — enable/disable/retarget — with no Meet-tab reload.
 * So the widget never touches the registry directly: config is the one source of
 * truth, exactly as the Options page already treats it. That also makes every
 * toggle survive a reload for free (it's persisted) and keeps the widget, the
 * Options page and any other config writer converging on one code path.
 *
 * The four control groups, and the config they own:
 *  - **Stream Deck** on/off  → `ws.enabled`
 *  - **Dev-bridge** on/off   → `ws.devBridge.enabled` (flips the live ws between
 *    the plugin port and the bridge proxy port, #6)
 *  - **MIDI** on/off         → `midi.enabled`
 *  - **MIDI device checklist** → `midi.devices` (the multi-select, #5)
 *
 * Survival mirrors the `src/meet/model.ts` pattern: the widget owns a single
 * Shadow-DOM host appended to `document.documentElement` (never `<body>`, which
 * Meet swaps), watched by a `documentElement` `MutationObserver` that re-appends
 * the host if Meet ever detaches it. The shadow root isolates Meet's global CSS
 * from the widget and vice-versa.
 */

/** A connected MIDI input, reduced to the fields the checklist and config need. */
export type MidiInputInfo = { id: string; name: string; manufacturer: string };

/**
 * The widget's window onto the connected MIDI inputs — the seam that keeps Web
 * MIDI (absent in jsdom) out of the widget so it stays testable. `list` is the
 * currently-connected inputs; `subscribe` fires on hotplug/unplug.
 */
export interface MidiInputSource {
  list(): MidiInputInfo[];
  subscribe(onChange: () => void): Disposer;
}

/** A `MidiInputSource` with no inputs and no hotplug — the fallback when Web MIDI is unavailable. */
export const NO_MIDI_INPUTS: MidiInputSource = {
  list: () => [],
  subscribe: () => () => {},
};

/**
 * The widget's window onto live transport status — the read-only counterpart to
 * {@link MidiInputSource}. `snapshot` is the current {@link TransportStatus}
 * (only *enabled* transports keyed, each a live boolean); `subscribe` fires on
 * any change. This is the whole of the widget's status power: it can *read*
 * liveness but has no handle on the `TransportRegistry`, so #13's pure
 * config-writer separation survives.
 */
export interface TransportStatusSource {
  snapshot(): TransportStatus;
  subscribe(onChange: () => void): Disposer;
}

/** A status source that reports nothing live and never changes — the default when unwired. */
export const NO_TRANSPORT_STATUS: TransportStatusSource = {
  snapshot: () => ({}),
  subscribe: () => () => {},
};

/**
 * Wrap the browser's Web MIDI access as a {@link MidiInputSource}. Uses
 * `addEventListener("statechange")` rather than assigning `onstatechange`, so it
 * never clobbers the {@link MidiTransport}'s own hotplug handler if the browser
 * hands back a shared `MIDIAccess`.
 */
export async function webMidiInputSource(nav: Navigator = navigator): Promise<MidiInputSource> {
  const access = await nav.requestMIDIAccess();
  return {
    list: () => {
      const inputs: MidiInputInfo[] = [];
      for (const [, input] of access.inputs) {
        if (input.state !== "connected") {
          continue;
        }
        inputs.push({
          id: input.id,
          name: input.name ?? "",
          manufacturer: input.manufacturer ?? "",
        });
      }
      return inputs;
    },
    subscribe: (onChange) => {
      const handler = (): void => onChange();
      access.addEventListener("statechange", handler);
      return () => access.removeEventListener("statechange", handler);
    },
  };
}

export type WidgetDeps = {
  local: chrome.storage.LocalStorageArea;
  onChanged: typeof chrome.storage.onChanged;
  /** Connected MIDI inputs for the checklist; {@link NO_MIDI_INPUTS} when Web MIDI is off. */
  midi?: MidiInputSource;
  /** Live transport liveness for the row dots; {@link NO_TRANSPORT_STATUS} when unwired. */
  status?: TransportStatusSource;
  doc?: Document;
};

/** A mounted widget; call {@link TransportWidget.destroy} to remove it and drop every listener. */
export interface TransportWidget {
  destroy(): void;
}

/**
 * Is this connected input covered by the persisted selection? `"all"` covers
 * every input; an explicit list uses the shared {@link matchesMidiDevice} rule.
 */
function isSelected(devices: MidiDevices, input: MidiInputInfo): boolean {
  return devices === "all" || devices.some((ref) => matchesMidiDevice(input, ref));
}

/**
 * The new `midi.devices` after a checklist edit. Any interaction materializes an
 * **explicit list** (leaving the `"all"` sentinel — an explicit multi-select is,
 * by definition, explicit). Selected refs for inputs that aren't currently
 * connected are **preserved**, so unplugging a device and toggling another never
 * silently drops the absent one. (Returning to `"all"` is intentionally not an
 * affordance here; it's the default state, reachable by clearing config.)
 */
function nextDevices(
  prev: MidiDevices,
  inputs: MidiInputInfo[],
  checked: Set<string>,
): MidiDeviceRef[] {
  const preserved =
    prev === "all" ? [] : prev.filter((ref) => !inputs.some((i) => matchesMidiDevice(i, ref)));
  const selected: MidiDeviceRef[] = inputs
    .filter((i) => checked.has(i.id))
    .map(({ id, name, manufacturer }) => ({ id, name, manufacturer }));
  return [...preserved, ...selected];
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    node.append(child);
  }
  return node;
}

/**
 * Set a live dot's colour from the transport's (enabled, active) state: hidden
 * when disabled, green when enabled-and-active, amber when enabled-but-not (ws
 * reconnecting, MIDI on with nothing bound). Only the two real transport rows —
 * Stream Deck and MIDI — carry a dot.
 */
function paintDot(dot: HTMLElement, enabled: boolean, active: boolean): void {
  dot.className = !enabled ? "dot hidden" : active ? "dot live" : "dot stale";
}

/**
 * Build a labelled toggle-switch row; returns the row and its checkbox. Rows
 * for a *real transport* (`withDot`) also carry a live-status dot before the
 * switch; modifier rows (dev-bridge) and the checklist omit it.
 */
function toggleRow(
  doc: Document,
  label: string,
  withDot = false,
): { row: HTMLDivElement; sub: HTMLElement; input: HTMLInputElement; dot?: HTMLElement } {
  const sub = el(doc, "small");
  const input = el(doc, "input", { type: "checkbox" });
  const dot = withDot ? el(doc, "span", { className: "dot hidden" }) : undefined;
  const trailing: (Node | string)[] = [];
  if (dot !== undefined) {
    trailing.push(dot);
  }
  trailing.push(
    el(doc, "label", { className: "sw" }, [input, el(doc, "span", { className: "track" })]),
  );
  const row = el(doc, "div", { className: "row" }, [
    el(doc, "div", { className: "lbl" }, [label, sub]),
    ...trailing,
  ]);
  return { row, sub, input, dot };
}

export function mountWidget(deps: WidgetDeps): TransportWidget {
  const doc = deps.doc ?? document;
  const source = deps.midi ?? NO_MIDI_INPUTS;
  const statusSource = deps.status ?? NO_TRANSPORT_STATUS;

  // Self-owned Shadow-DOM host on <html>: isolates Meet's global CSS from the
  // widget (and vice-versa) and gives the survival observer one node to guard.
  const host = el(doc, "div", { id: "callctl-widget-host" });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(el(doc, "style", { textContent: WIDGET_STYLE }));

  const badge = el(doc, "span", { className: "badge" });
  const chev = el(doc, "span", { className: "chev", textContent: "▾" });
  const head = el(doc, "div", { className: "head", title: "Click to fold / unfold" }, [
    el(doc, "span", { className: "grip", textContent: "🎛️" }),
    el(doc, "b", { textContent: "Transports" }),
    badge,
    chev,
  ]);

  const sd = toggleRow(doc, "Stream Deck", true);
  const dev = toggleRow(doc, "Dev-bridge");
  const midi = toggleRow(doc, "MIDI", true);
  const midiList = el(doc, "div", { className: "midiList" });

  const body = el(doc, "div", { className: "body" }, [sd.row, dev.row, midi.row, midiList]);
  const card = el(doc, "div", { className: "card" }, [head, body]);
  shadow.append(card);

  head.addEventListener("click", () => card.classList.toggle("folded"));

  // Config is the source of truth; we cache the last envelope only to compute
  // read-modify-writes and to repaint. Saves always reload first (like the
  // Options page) so we never clobber a field this widget doesn't render.
  let config: TransportConfig | null = null;

  const save = async (mutate: (c: TransportConfig) => TransportConfig): Promise<void> => {
    const current = await loadConfig(deps.local);
    await saveConfig(deps.local, mutate(current));
  };

  sd.input.addEventListener("change", () => {
    const enabled = sd.input.checked;
    void save((c) => ({ ...c, ws: { ...c.ws, enabled } }));
  });
  dev.input.addEventListener("change", () => {
    const enabled = dev.input.checked;
    void save((c) => ({ ...c, ws: { ...c.ws, devBridge: { ...c.ws.devBridge, enabled } } }));
  });
  midi.input.addEventListener("change", () => {
    const enabled = midi.input.checked;
    void save((c) => ({ ...c, midi: { ...c.midi, enabled } }));
  });

  // The device checklist reads its checkbox states straight from the DOM at
  // edit time, so it's robust to hotplug between renders.
  const midiCheckboxes = new Map<string, HTMLInputElement>();
  const onMidiListChange = (): void => {
    const inputs = source.list();
    const checked = new Set([...midiCheckboxes].filter(([, box]) => box.checked).map(([id]) => id));
    void save((c) => ({
      ...c,
      midi: { ...c.midi, devices: nextDevices(c.midi.devices, inputs, checked) },
    }));
  };

  const paint = (): void => {
    if (config === null) {
      return;
    }
    sd.input.checked = config.ws.enabled;
    sd.sub.textContent = `ws · port ${config.ws.port}`;
    dev.input.checked = config.ws.devBridge.enabled;
    dev.sub.textContent = `route ws → ${config.ws.devBridge.port}`;
    midi.input.checked = config.midi.enabled;

    const inputs = source.list();
    midi.sub.textContent = `${inputs.length} input${inputs.length === 1 ? "" : "s"} seen`;
    const onCount = (config.ws.enabled ? 1 : 0) + (config.midi.enabled ? 1 : 0);
    badge.textContent = `${onCount} on`;

    // Live dots on the two real transport rows, keyed off both the config
    // (enabled?) and the status feed (active?). A key is absent from the snapshot
    // unless that transport is live, so `?? false` reads a not-yet-connected
    // transport as not-active (amber, not green). The collapsed pill tints amber
    // (`.warn`) when any enabled transport is inactive, surfacing a problem
    // without unfolding.
    const status = statusSource.snapshot();
    const wsStale = config.ws.enabled && status.ws !== true;
    const midiStale = config.midi.enabled && status.midi !== true;
    if (sd.dot) {
      paintDot(sd.dot, config.ws.enabled, status.ws ?? false);
    }
    if (midi.dot) {
      paintDot(midi.dot, config.midi.enabled, status.midi ?? false);
    }
    card.classList.toggle("warn", wsStale || midiStale);

    // Rebuild the checklist from the connected inputs; disabled (greyed) while
    // MIDI itself is off, since selecting devices for a dead transport is moot.
    midiCheckboxes.clear();
    midiList.replaceChildren();
    if (inputs.length === 0) {
      midiList.append(el(doc, "div", { className: "midiEmpty", textContent: "No MIDI inputs" }));
    }
    for (const input of inputs) {
      const box = el(doc, "input", {
        type: "checkbox",
        checked: isSelected(config.midi.devices, input),
        disabled: !config.midi.enabled,
      });
      box.addEventListener("change", onMidiListChange);
      midiCheckboxes.set(input.id, box);
      const label = input.name || input.id;
      midiList.append(el(doc, "label", { className: box.checked ? "on" : "" }, [box, label]));
    }
  };

  // Reflect config edits made anywhere (this widget, the Options page, another
  // Meet tab) — chrome.storage.onChanged fires in the originating context too,
  // so our own saves round-trip through here and repaint.
  const onStorage = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ): void => {
    if (areaName !== "local" || !("config" in changes)) {
      return;
    }
    const next = changes.config.newValue as TransportConfig | undefined;
    if (next !== undefined) {
      config = next;
      paint();
    }
  };
  deps.onChanged.addListener(onStorage);

  // A hotplug changes which inputs the checklist shows.
  const unsubscribeMidi = source.subscribe(paint);

  // A transport connecting/dropping (or being enabled/disabled) repaints the dots.
  const unsubscribeStatus = statusSource.subscribe(paint);

  // Re-append the host if Meet ever detaches it (a re-render / <body> swap).
  // Coalesced to one guard per microtask, like model.ts's rescan.
  const attach = (): void => {
    if (!host.isConnected) {
      doc.documentElement.append(host);
    }
  };
  let guardQueued = false;
  const observer = new MutationObserver(() => {
    if (guardQueued) {
      return;
    }
    guardQueued = true;
    queueMicrotask(() => {
      guardQueued = false;
      attach();
    });
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  attach();

  // Initial paint from the persisted config.
  void loadConfig(deps.local).then((c) => {
    config = c;
    paint();
  });

  return {
    destroy() {
      observer.disconnect();
      deps.onChanged.removeListener(onStorage);
      unsubscribeMidi();
      unsubscribeStatus();
      host.remove();
    },
  };
}
