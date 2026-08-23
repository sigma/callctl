import type { ClientHello, ClientId, Message } from "@callctl/protocol";

/**
 * A registry key standing for **one attached connection**.
 *
 * Minted by the caller per socket and opaque to everyone: the registry never
 * interprets it, it only needs two connections to be tellable apart.
 */
export type ConnectionKey = symbol;

/**
 * One attached client, as the registry sees it. The `send` port is whatever
 * pipe the client arrived on, so the registry never imports `ws`.
 */
export interface ConnectedClient {
  readonly id: ClientId;
  /** Coarse self-declared surface name. Logs and UI only — never routing. */
  readonly surface: string;
  /** Every op this client handles: its derived capability set. */
  readonly ops: ReadonlySet<string>;
  /** Human name, e.g. a Chat account's full domain. Refinable after connect. */
  readonly label?: string;
  /** The client page's UI language. Refinable after connect. */
  readonly lang?: string;
  send: (message: Message) => void;
}

/**
 * Who is attached and what each of them can do.
 *
 * The whole point is that **it does not evict**: two clients coexist, which is
 * the prerequisite for a Chat surface existing at all beside Meet (ADR 0001).
 * Where the old single-connection code asked "is the extension connected?", the
 * question here is always **per capability** — "is anything attached that
 * handles `chat.getRoster`?" — so a Chat key cannot light up merely because a
 * Meet tab is open.
 *
 * 🔴 **Keyed by connection, not by id.** An earlier version stored one entry per
 * `ClientId`, which quietly reintroduced eviction one level down: anything that
 * shared an id shared a slot. That is not hypothetical — a Meet tab and a Chat
 * window in one Chrome profile did share one, so opening Meet knocked every Chat
 * key dark, and closing a superseded socket evicted the live client that had
 * replaced it. Connections are what actually attach and detach, so they are what
 * this keys on; an id is an **attribute**, and several connections may bear one.
 *
 * Insertion order is meaningful: it is what "last-wins" means.
 */
export class ClientRegistry {
  /** Attachment order, oldest first. A `Map` preserves it across re-inserts. */
  readonly #clients = new Map<ConnectionKey, ConnectedClient>();
  readonly #listeners = new Set<() => void>();

  /**
   * Attach a connection, or refresh one that re-handshook (a refined label,
   * say).
   *
   * A re-handshake keeps the connection's original position rather than
   * promoting it to newest: refining a label is not a re-attachment, and letting
   * it jump the last-wins queue would make a late-arriving account label
   * silently re-target every unbound key. (`Map.set` on an existing key keeps
   * its slot, which is exactly this.)
   */
  attach(
    key: ConnectionKey,
    hello: ClientHello,
    send: (message: Message) => void,
  ): ConnectedClient {
    const client: ConnectedClient = {
      id: hello.id,
      surface: hello.surface,
      ops: new Set(hello.ops),
      ...(hello.label !== undefined ? { label: hello.label } : {}),
      ...(hello.lang !== undefined ? { lang: hello.lang } : {}),
      send,
    };
    this.#clients.set(key, client);
    this.#notify();
    return client;
  }

  /**
   * Detach one connection, dropping its capabilities with it. A no-op if it is
   * not attached.
   *
   * Scoped to the connection that closed, never to its id: another connection
   * may legitimately bear the same id — a second Meet tab, or the other surface
   * of the same extension install — and it must survive this one going away.
   */
  detach(key: ConnectionKey): void {
    if (this.#clients.delete(key)) {
      this.#notify();
    }
  }

  /** The client on a specific connection. */
  at(key: ConnectionKey): ConnectedClient | undefined {
    return this.#clients.get(key);
  }

  /**
   * The **newest** client bearing `id`, or `undefined`.
   *
   * Newest rather than oldest for the same reason routing is last-wins: where
   * two connections share an id, the recent one is the one you mean.
   */
  get(id: ClientId): ConnectedClient | undefined {
    return newest(this.all(), id);
  }

  /** Every attached client, oldest first. */
  all(): ConnectedClient[] {
    return [...this.#clients.values()];
  }

  /** Every attached connection, oldest first. For bulk teardown. */
  keys(): ConnectionKey[] {
    return [...this.#clients.keys()];
  }

  /** Is anything attached that handles `op`? The per-capability liveness query. */
  handles(op: string): boolean {
    return this.route(op) !== undefined;
  }

  /** Every client that handles `op`, oldest first. */
  claimants(op: string): ConnectedClient[] {
    return this.all().filter((c) => c.ops.has(op));
  }

  /**
   * Pick the client a frame should go to.
   *
   * With a `client` target, only a client bearing that id — and only if it
   * actually handles the op, so a key bound to a Chat client never drives a Meet
   * tab that happens to share the id.
   *
   * With no target, **last-wins**: the most recently attached claimant. That is
   * today's exact Meet behaviour, where a second Meet tab is a stale leftover.
   * Broadcasting instead would toggle the mic in a call you cannot see.
   */
  route(op: string, target?: ClientId): ConnectedClient | undefined {
    const claimants = this.claimants(op);
    if (target !== undefined) {
      return newest(claimants, target);
    }
    return claimants[claimants.length - 1];
  }

  /** Subscribe to attach/detach/refresh. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * The last client in attachment order bearing `id`.
 *
 * A reverse scan rather than `Array.findLast`, which needs an ES2023 lib this
 * package does not otherwise want.
 */
function newest(clients: ConnectedClient[], id: ClientId): ConnectedClient | undefined {
  for (let i = clients.length - 1; i >= 0; i -= 1) {
    const client = clients[i];
    if (client?.id === id) {
      return client;
    }
  }
  return undefined;
}
