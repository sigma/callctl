import type { AddressInfo } from "node:net";
import { type Message, parseHello, SessionEvent } from "@callctl/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientRegistry, type ConnectedClient, type ConnectionKey } from "./client-registry.js";

export interface BridgeOptions {
  /** Port to listen on. */
  port: number;
  /** Bind address. Loopback by default — the bridge is strictly local. */
  host?: string;
  log?: (m: string) => void;
  /** How long a fresh socket may stay silent before it is refused. */
  handshakeTimeoutMs?: number;
}

/** How long a socket may go without handshaking before we give up on it. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The local websocket **server**, holding as many clients as dial in.
 *
 * Surface-neutral by construction: it knows about sockets, handshakes, the
 * client registry and routing, and nothing about mics or unread counts. A
 * consumer (`MeetRemote`, a future `ChatRemote`, the dev bridge) subscribes for
 * the events it cares about and owns its own state.
 */
export class Bridge {
  readonly #port: number;
  readonly #host: string;
  readonly #log: (m: string) => void;
  readonly #handshakeTimeoutMs: number;

  #wss: WebSocketServer | null = null;

  readonly clients = new ClientRegistry();
  readonly #messageListeners = new Set<(m: Message, from: ConnectedClient) => void>();

  constructor(opts: BridgeOptions) {
    this.#port = opts.port;
    this.#host = opts.host ?? "127.0.0.1";
    this.#log = opts.log ?? (() => {});
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  /**
   * Start listening. Resolves once bound, rejects if the port is unavailable.
   * Safe to call twice; the second call resolves immediately.
   */
  start(): Promise<void> {
    if (this.#wss !== null) {
      return Promise.resolve();
    }

    const wss = new WebSocketServer({ host: this.#host, port: this.#port });
    this.#wss = wss;
    wss.on("connection", (conn) => this.#onConnection(conn));

    return new Promise((resolve, reject) => {
      wss.once("listening", () => {
        this.#log(`bridge listening on ${this.#host}:${this.address?.port}`);
        wss.on("error", (err) => this.#log(`bridge server error: ${err.message}`));
        resolve();
      });
      wss.once("error", reject);
    });
  }

  /** Stop listening and drop every client. */
  close(): void {
    for (const key of this.clients.keys()) {
      this.clients.detach(key);
    }
    for (const socket of this.#wss?.clients ?? []) {
      socket.close();
    }
    this.#wss?.close();
    this.#wss = null;
  }

  /** The bound address once listening, or `null`. */
  get address(): AddressInfo | null {
    const a = this.#wss?.address();
    return a !== undefined && typeof a !== "string" ? a : null;
  }

  /** Is anything attached that handles `op`? */
  handles(op: string): boolean {
    return this.clients.handles(op);
  }

  /**
   * Route a frame to a client. Honours `message.client` as a target; with none,
   * last-wins among the claimants. Returns whether anything took it, so a
   * caller can log a dropped command rather than fail silently.
   */
  send(message: Message): boolean {
    const client = this.clients.route(message.event, message.client);
    if (client === undefined) {
      this.#log(`dropping ${message.event}: no attached client handles it`);
      return false;
    }
    client.send(message);
    return true;
  }

  /** Subscribe to inbound frames from any handshaken client. */
  onMessage(listener: (m: Message, from: ConnectedClient) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  /** Subscribe to the attached set changing. */
  onClientsChange(listener: () => void): () => void {
    return this.clients.subscribe(listener);
  }

  #onConnection(conn: WebSocket): void {
    // One key per socket. The registry is keyed by connection, so two clients
    // sharing an id — a second Meet tab, or the other surface of the same
    // extension install — coexist instead of overwriting each other.
    const key: ConnectionKey = Symbol("client-connection");
    let attached = false;

    // A socket that never handshakes is a stale client, not a slow one. Refuse
    // it out loud rather than letting it sit there attached-but-unroutable.
    const timer = setTimeout(() => {
      if (!attached) {
        this.#refuse(conn, "sent no handshake");
      }
    }, this.#handshakeTimeoutMs);

    conn.on("message", (raw) => {
      let m: Message;
      try {
        m = JSON.parse(raw.toString()) as Message;
      } catch {
        this.#log(`ignoring non-JSON message: ${raw.toString()}`);
        return;
      }

      if (m.event === SessionEvent.Hello) {
        const hello = parseHello(m.data);
        if (hello === undefined) {
          clearTimeout(timer);
          this.#refuse(conn, `sent a malformed handshake: ${m.data}`);
          return;
        }
        clearTimeout(timer);
        attached = true;
        const client = this.clients.attach(key, hello, (out) => conn.send(JSON.stringify(out)));
        this.#log(
          `client attached: ${client.surface} ${client.id}` +
            `${client.label !== undefined ? ` (${client.label})` : ""}` +
            ` handling ${client.ops.size} ops`,
        );
        return;
      }

      // No handshake, no routing: we have no idea what this client can do, and
      // guessing would mean a permanent second semantics to support forever.
      if (!attached) {
        clearTimeout(timer);
        this.#refuse(conn, `sent ${m.event} before handshaking`);
        return;
      }

      const from = this.clients.at(key);
      if (from === undefined) {
        return;
      }
      // Stamp the source so a consumer can tell *which* client's state moved.
      const tagged: Message = { ...m, client: from.id };
      for (const listener of this.#messageListeners) {
        listener(tagged, from);
      }
    });

    conn.on("close", () => {
      clearTimeout(timer);
      if (attached) {
        this.#log(`client detached: ${this.clients.at(key)?.id ?? "?"}`);
        // By connection, never by id: a superseded socket closing must not
        // evict the live client that replaced it.
        this.clients.detach(key);
      }
    });

    conn.on("error", (err) => this.#log(`client error: ${err.message}`));
  }

  /**
   * Refuse a client, loudly. This failure mode is otherwise invisible — an
   * unpacked extension left over from before the handshake landed connects
   * happily and then does nothing at all — so the log line names the cure.
   */
  #refuse(conn: WebSocket, what: string): void {
    this.#log(
      `refusing client: it ${what}. The likely cause is a stale extension build — ` +
        `reload the extension in chrome://extensions, then reload the tab.`,
    );
    conn.close();
  }
}
