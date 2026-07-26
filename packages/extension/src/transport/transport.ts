import type { Message } from "@meetdeck/protocol";
import type { MeetPlugin } from "../plugins/plugin.js";

export type { Message };

/**
 * A bidirectional link between the extension and some controller.
 *
 * This is the legacy `Protocol` interface, renamed to `Transport` so it no
 * longer collides with the shared `@meetdeck/protocol` package (which owns the
 * *wire vocabulary* — event names, reaction labels, the `Message` envelope).
 * A `Transport` is the *pipe*; the vocabulary flowing through it comes from
 * `@meetdeck/protocol`.
 *
 * Concrete transports: {@link WSProtocol} (the Stream Deck bridge websocket),
 * {@link MidiProtocol} (Web MIDI input), {@link MultiProtocol} (fan-out).
 */
export interface Transport {
  /** Called once the transport is ready to carry traffic (e.g. ws opened). */
  onConnect: () => void;

  /** Push a message to the controller (state events flow this way). */
  send: (message: Message) => void;

  /** Register a handler for an inbound command/query keyed by event name. */
  handle: (op: string, h: (msg: Message) => void) => void;

  /** Tear the transport down permanently (stop reconnecting). */
  shutdown: () => void;

  /** Let a plugin install its hooks + handlers onto this transport. */
  acceptPlugin: (plugin: MeetPlugin) => void;
}
