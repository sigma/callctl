import type { Message } from "@callctl/protocol";
import { BaseTransport, type Retargetable } from "./transport.js";

/** How long to wait before redialing after a drop/failed connect. */
const RECONNECTION_INTERVAL_SECS = 2;

/**
 * The Stream Deck bridge transport: dials `ws://127.0.0.1:<port>` (the local
 * `MeetRemote` server the plugin runs) and auto-reconnects every 2s while the
 * Meet tab is open.
 *
 * Descendant of the legacy `WSProtocol`, now built on {@link BaseTransport} so
 * it owns its teardown (`detach` runs parked disposers + closes the socket).
 * It lives in the content script, so it enjoys a long-lived context — the MV3
 * service-worker idle-kill never touches it.
 *
 * The port is mutable, not a readonly ctor arg: the instance outlives any single
 * port. {@link retarget} performs a live port switch — redial on the new port
 * while keeping every installed hook and handler in place. This is the whole of
 * the dev-bridge port switch (#6) and the Options port change (#7): only *this*
 * socket blips; the content script — and thus the call — never reloads.
 */
export class WSTransport extends BaseTransport implements Retargetable<number> {
  #port: number;
  #ws: WebSocket | null = null;
  readonly #handlers = new Map<string, (msg: Message) => void>();
  #shut = false;

  constructor(port: number) {
    super();
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
      // Re-push state on (re)connect so the LEDs start correct — this is why the
      // dev-bridge/port-change retarget is transparent: the redial fires this.
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

  /**
   * Live port switch: redial on a new port without disturbing installed plugins.
   * A no-op if the port is unchanged. Closing the current socket funnels into
   * `onclose`, which reconnects to the updated `#port` (`#shut` stays false).
   */
  retarget(port: number): void {
    if (port === this.#port) {
      return;
    }
    this.#port = port;
    this.#ws?.close();
  }

  send(message: Message): void {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  handle(op: string, h: (msg: Message) => void): void {
    this.#handlers.set(op, h);
    // Registering a handler is itself an installation → park its removal so
    // `detach` unwires it (see BaseTransport).
    this.onDetach(() => this.#handlers.delete(op));
  }

  protected close(): void {
    this.#shut = true; // stop the reconnect loop; detach is permanent for this instance
    this.#ws?.close();
  }
}
