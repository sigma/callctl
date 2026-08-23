import { type ClientHello, type Message, message, SessionEvent } from "@callctl/protocol";
import { BaseTransport, type Retargetable } from "./transport.js";

/**
 * Everything the handshake carries *except* the capability set, which this
 * transport derives itself.
 *
 * A function, not a value: the account label may resolve seconds after the page
 * loads, so the transport re-reads it on every (re)connect and on
 * {@link WSTransport.rehandshake}. Absent fields simply do not travel.
 */
export type SessionSource = () => Omit<ClientHello, "ops">;

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
 *
 * The first frame out is always the mandatory handshake (ADR 0001). Its
 * capability set is **derived, not declared** — literally the ops the installed
 * plugins registered via {@link handle}, which are all in place by the time the
 * socket opens. So there is no op→capability table to keep in step, and the set
 * is automatically correct the moment someone adds a plugin.
 */
export class WSTransport extends BaseTransport implements Retargetable<number> {
  #port: number;
  #ws: WebSocket | null = null;
  readonly #handlers = new Map<string, (msg: Message) => void>();
  readonly #session: SessionSource;
  #shut = false;

  constructor(port: number, session: SessionSource) {
    super();
    this.#port = port;
    this.#session = session;
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
      this.refreshStatus(); // active → false (onerror also funnels through here)
      if (!this.#shut) {
        setTimeout(() => this.#connect(), RECONNECTION_INTERVAL_SECS * 1000);
      }
    };

    ws.onopen = () => {
      // The handshake goes first, before any state: until the bridge knows what
      // this client handles it has nowhere to route, and an un-handshaken
      // client is refused outright.
      this.rehandshake();
      // Re-push state on (re)connect so the LEDs start correct — this is why the
      // dev-bridge/port-change retarget is transparent: the redial fires this.
      this.refreshStatus(); // active → true
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
   * (Re)send the handshake with the current capability set and session fields.
   *
   * Sent on every connect, and again whenever a refinable field improves — a
   * Chat client that could not name its account at load time refines its label
   * this way rather than reconnecting.
   */
  rehandshake(): void {
    const hello: ClientHello = { ...this.#session(), ops: [...this.#handlers.keys()] };
    this.send(message(SessionEvent.Hello, JSON.stringify(hello)));
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

  /** Live iff the socket is actually open — connecting/retrying reads as not-active. */
  override active(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
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
