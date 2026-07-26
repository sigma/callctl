import type { MeetPlugin } from "./plugins/plugin.js";
import type { Transport } from "./transport/transport.js";

/**
 * Wires a set of plugins onto a transport. Faithful port of the legacy `App`.
 */
export class App {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  run(plugins: MeetPlugin[]): void {
    for (const plugin of plugins) {
      this.#transport.acceptPlugin(plugin);
    }
  }
}
