import type { Message } from "@callctl/protocol";
import { type MidiDevices, matchesMidiDevice } from "../config.js";
import type { MeetPlugin } from "../plugins/plugin.js";
import { BaseTransport, type Retargetable } from "./transport.js";

/**
 * Web MIDI input transport. Descendant of the legacy `MidiProtocol`, now on
 * {@link BaseTransport} so it can be detached cleanly (handlers self-park their
 * removal and {@link close} unbinds the input callbacks).
 *
 * Unlike the websocket, MIDI is input-only: it never `send`s state back. But it
 * is not fire-and-forget either — it binds only the **selected** input devices
 * (the persisted `midi.devices` set, or `"all"`) and stays live as devices come
 * and go: Web MIDI `statechange` (hotplug/unplug) triggers a
 * {@link MidiTransport.reconcile | reconcile}, as does a live device re-select
 * via {@link retarget}. Incoming Control-Change messages are dispatched to
 * plugin handlers by ordinal (see {@link onMidiMessage}).
 *
 * The enable/disable lifecycle (issue #10) is the registry's: the master MIDI
 * toggle off is `TransportRegistry.disable("midi")`, whose `detach` → `close`
 * unbinds every input and drops the `statechange` listener, so a disabled
 * transport holds no bindings at all.
 *
 * The dispatch mapping is quirky but preserved exactly:
 *  - the CC controller number selects the plugin **by its `ID()`**,
 *  - the high nibble of the CC value selects the handler by the order it was
 *    registered (`handle()` call index),
 *  - the low nibble is passed through as the message `data`.
 */
export class MidiTransport extends BaseTransport implements Retargetable<MidiDevices> {
  #currentPlugin = 0;
  #currentOp = 0;

  /** Which inputs to bind: `"all"`, or the persisted selected-device refs. */
  #selection: MidiDevices;
  /** The live MIDI access, once acquired; null before ready and after close. */
  #access: MIDIAccess | null = null;

  /** plugin ID → (op ordinal → handler). */
  readonly midiMap = new Map<number, Map<number, (msg: Message) => void>>();
  /** Inputs we currently have a callback bound on, so we can unbind them. */
  readonly #inputs = new Set<MIDIInput>();

  constructor(selection: MidiDevices = "all", nav: Navigator = navigator) {
    super();
    this.#selection = selection;
    nav
      .requestMIDIAccess()
      .then((midiAccess) => {
        console.log("MIDI Ready!");
        this.#access = midiAccess;
        // Any hotplug/unplug re-runs the reconcile against the current inputs.
        midiAccess.onstatechange = () => this.reconcile();
        this.reconcile();
      })
      .catch(() => {
        console.log("Error accessing MIDI devices");
      });
  }

  /**
   * Live device re-select: swap the selected set and re-bind. Cheap enough to
   * run on every change — no teardown of installed plugins (see
   * {@link Retargetable}).
   */
  retarget(selection: MidiDevices): void {
    this.#selection = selection;
    this.reconcile();
  }

  /**
   * Bring the bound inputs in line with the current selection and the currently
   * connected devices. Unbinds everything, then re-binds each connected input
   * the selection covers — idempotent, so it is safe to call on ready, on
   * hotplug/unplug, and on re-select. A no-op before access is acquired.
   */
  reconcile(): void {
    if (this.#access === null) {
      return;
    }
    for (const input of this.#inputs) {
      input.onmidimessage = null;
    }
    this.#inputs.clear();

    for (const [, input] of this.#access.inputs) {
      // A disconnected port lingers in the map on some browsers; skip it.
      if (input.state !== "connected" || !this.#selects(input)) {
        continue;
      }
      console.log(`Binding MIDI input device: ${input.id}`);
      input.onmidimessage = (ev) => onMidiMessage(this, ev);
      this.#inputs.add(input);
    }
    // Binding set may have changed (hotplug, re-select, initial ready) → liveness.
    this.refreshStatus();
  }

  /** Live iff at least one selected device is actually bound. */
  override active(): boolean {
    return this.#inputs.size > 0;
  }

  /** Whether the current selection covers this input (id-primary, then name+mfr). */
  #selects(input: MIDIInput): boolean {
    if (this.#selection === "all") {
      return true;
    }
    return this.#selection.some((ref) => matchesMidiDevice(input, ref));
  }

  acceptPlugin(plugin: MeetPlugin): void {
    this.#currentPlugin = plugin.ID();
    console.log(`Accepting plugin ${plugin.ID()}`);
    this.#currentOp = 0;
    this.midiMap.set(this.#currentPlugin, new Map());

    plugin.installHooks(this);
    plugin.installHandlers(this);
  }

  handle(op: string, h: (msg: Message) => void): void {
    console.log(`Registering ${op} for ${this.#currentPlugin}/${this.#currentOp}`);
    const plugin = this.#currentPlugin;
    const ordinal = this.#currentOp;
    this.midiMap.get(plugin)?.set(ordinal, h);
    this.#currentOp += 1;
    // Self-park removal so `detach` unwires this handler (see BaseTransport).
    this.onDetach(() => this.midiMap.get(plugin)?.delete(ordinal));
  }

  // MIDI never pushes state back.
  send(_message: Message): void {}

  protected close(): void {
    if (this.#access !== null) {
      this.#access.onstatechange = null;
      this.#access = null;
    }
    for (const input of this.#inputs) {
      input.onmidimessage = null;
    }
    this.#inputs.clear();
    this.midiMap.clear();
    this.refreshStatus(); // no bindings left → active → false
  }
}

function onMidiMessage(protocol: MidiTransport, ev: MIDIMessageEvent): void {
  const data = ev.data;
  if (data === null || data.length !== 3) {
    return;
  }

  // status is the first byte.
  const status = data[0];
  // command is the four most significant bits of the status byte.
  const command = status >>> 4;
  // channel 0-15 is the lower four bits.
  const channel = status & 0xf;

  // Only Control-Change (command 11) on channel 15 carries our mapping.
  if (command !== 11 || channel !== 15) {
    return;
  }

  const cc = data[1];
  const val = data[2];
  const cmd = val >>> 4;
  const idx = val & 0xf;

  const handler = protocol.midiMap.get(cc)?.get(cmd);
  handler?.({ event: "", data: idx.toString() });
}
