import type { Message } from "@callctl/protocol";
import type { MeetPlugin } from "../plugins/plugin.js";
import { BaseTransport } from "./transport.js";

/**
 * Web MIDI input transport. Descendant of the legacy `MidiProtocol`, now on
 * {@link BaseTransport} so it can be detached cleanly (handlers self-park their
 * removal and {@link close} unbinds the input callbacks).
 *
 * Unlike the websocket, MIDI is input-only: it never `send`s state back and has
 * no connection lifecycle to speak of — everything happens in the constructor,
 * which subscribes to every MIDI input device. Incoming Control-Change messages
 * are dispatched to plugin handlers by ordinal (see {@link onMidiMessage}).
 *
 * The dispatch mapping is quirky but preserved exactly:
 *  - the CC controller number selects the plugin **by its `ID()`**,
 *  - the high nibble of the CC value selects the handler by the order it was
 *    registered (`handle()` call index),
 *  - the low nibble is passed through as the message `data`.
 */
export class MidiTransport extends BaseTransport {
  #currentPlugin = 0;
  #currentOp = 0;

  /** plugin ID → (op ordinal → handler). */
  readonly midiMap = new Map<number, Map<number, (msg: Message) => void>>();
  /** Inputs we bound a callback on, so {@link close} can unbind them. */
  readonly #inputs = new Set<MIDIInput>();

  constructor(nav: Navigator = navigator) {
    super();
    nav
      .requestMIDIAccess()
      .then((midiAccess) => {
        console.log("MIDI Ready!");
        for (const [, input] of midiAccess.inputs) {
          console.log(`MIDI input device: ${input.id}`);
          input.onmidimessage = (ev) => onMidiMessage(this, ev);
          this.#inputs.add(input);
        }
      })
      .catch(() => {
        console.log("Error accessing MIDI devices");
      });
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
    for (const input of this.#inputs) {
      input.onmidimessage = null;
    }
    this.#inputs.clear();
    this.midiMap.clear();
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
