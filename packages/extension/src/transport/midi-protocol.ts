import type { Message } from "@meetdeck/protocol";
import type { MeetPlugin } from "../plugins/plugin.js";
import type { Transport } from "./transport.js";

/**
 * Web MIDI input transport. Faithful port of the legacy `MidiProtocol`.
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
export class MidiProtocol implements Transport {
  #currentPlugin = 0;
  #currentOp = 0;

  /** plugin ID → (op ordinal → handler). */
  readonly midiMap = new Map<number, Map<number, (msg: Message) => void>>();

  constructor(nav: Navigator = navigator) {
    nav
      .requestMIDIAccess()
      .then((midiAccess) => {
        console.log("MIDI Ready!");
        for (const [, input] of midiAccess.inputs) {
          console.log(`MIDI input device: ${input.id}`);
          input.onmidimessage = (ev) => onMidiMessage(this, ev);
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
    this.midiMap.get(this.#currentPlugin)?.set(this.#currentOp, h);
    this.#currentOp += 1;
  }

  // MIDI is handled entirely in the constructor / callbacks; these are no-ops.
  onConnect: () => void = () => {};
  send(_message: Message): void {}
  shutdown(): void {}
}

function onMidiMessage(protocol: MidiProtocol, ev: MIDIMessageEvent): void {
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
