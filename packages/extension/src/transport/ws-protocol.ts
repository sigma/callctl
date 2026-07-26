import type { Message } from "@callctl/protocol";
import type { MeetPlugin } from "../plugins/plugin.js";
import type { Transport } from "./transport.js";

/** How long to wait before redialing after a drop/failed connect. */
const RECONNECTION_INTERVAL_SECS = 2;

/**
 * The Stream Deck bridge transport: dials `ws://127.0.0.1:<port>` (the local
 * `MeetRemote` server the plugin runs) and auto-reconnects every 2s while the
 * Meet tab is open.
 *
 * Faithful port of the legacy `WSProtocol`. It lives in the content script, so
 * it enjoys a long-lived context — the MV3 service-worker idle-kill never
 * touches it.
 */
export class WSProtocol implements Transport {
  onConnect: () => void = () => {};

  readonly #port: number;
  #ws: WebSocket | null = null;
  readonly #handlers = new Map<string, (msg: Message) => void>();
  #shut = false;

  constructor(port: number) {
    this.#port = port;
    this.#connect();
  }

  #connect(): void {
    const ws = new WebSocket(`ws://127.0.0.1:${this.#port}`);
    this.#ws = ws;

    ws.onerror = (event) => {
      console.error("WebSocket error; closing and reconnecting:", event);
      // Closing here funnels into onclose, which schedules the retry.
      ws.close();
    };

    ws.onclose = () => {
      // Fires on both disconnection and failure to connect.
      this.#ws = null;
      if (!this.#shut) {
        setTimeout(() => this.#connect(), RECONNECTION_INTERVAL_SECS * 1000);
      }
    };

    ws.onopen = () => {
      this.onConnect();
    };

    ws.onmessage = (event) => {
      let msg: Message;
      try {
        msg = JSON.parse(event.data as string) as Message;
      } catch {
        console.warn("Ignoring non-JSON message:", event.data);
        return;
      }

      const handler = this.#handlers.get(msg.event ?? "");
      if (handler === undefined) {
        console.warn("Received unknown event:", msg.event);
        return;
      }
      handler(msg);
    };
  }

  send(message: Message): void {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  handle(op: string, h: (msg: Message) => void): void {
    this.#handlers.set(op, h);
  }

  shutdown(): void {
    this.#shut = true;
    this.#ws?.close();
  }

  acceptPlugin(plugin: MeetPlugin): void {
    plugin.installHooks(this);
    plugin.installHandlers(this);
  }
}
