import type { Message } from "@meetdeck/protocol";
import type { MeetPlugin } from "../plugins/plugin.js";
import type { Transport } from "./transport.js";

/**
 * Fans every transport operation out to a set of underlying transports, so a
 * plugin can be driven from several input surfaces at once (the Stream Deck
 * bridge websocket *and* Web MIDI). Faithful port of the legacy `MultiProtocol`.
 */
export class MultiProtocol implements Transport {
  readonly #transports: Transport[];

  constructor(transports: Transport[]) {
    this.#transports = transports;
  }

  #apply(f: (t: Transport) => void): void {
    for (const t of this.#transports) {
      f(t);
    }
  }

  onConnect = (): void => {
    this.#apply((t) => t.onConnect());
  };

  send(message: Message): void {
    this.#apply((t) => t.send(message));
  }

  handle(op: string, h: (msg: Message) => void): void {
    this.#apply((t) => t.handle(op, h));
  }

  shutdown(): void {
    this.#apply((t) => t.shutdown());
  }

  acceptPlugin(plugin: MeetPlugin): void {
    this.#apply((t) => t.acceptPlugin(plugin));
  }
}
