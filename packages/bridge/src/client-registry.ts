import type { ClientHello, ClientId, Message } from "@callctl/protocol";

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
 * Insertion order is meaningful: it is what "last-wins" means.
 */
export class ClientRegistry {
  /** Attachment order, oldest first. A `Map` preserves it across re-inserts. */
  readonly #clients = new Map<ClientId, ConnectedClient>();
  readonly #listeners = new Set<() => void>();

  /**
   * Attach a client, or refresh one that re-handshook (a refined label, say).
   *
   * A re-handshake keeps the client's original position rather than promoting
   * it to newest: refining a label is not a re-attachment, and letting it jump
   * the last-wins queue would make a late-arriving account label silently
   * re-target every unbound key.
   */
  attach(hello: ClientHello, send: (message: Message) => void): ConnectedClient {
    const client: ConnectedClient = {
      id: hello.id,
      surface: hello.surface,
      ops: new Set(hello.ops),
      ...(hello.label !== undefined ? { label: hello.label } : {}),
      ...(hello.lang !== undefined ? { lang: hello.lang } : {}),
      send,
    };
    this.#clients.set(hello.id, client);
    this.#notify();
    return client;
  }

  /** Detach a client, dropping its capabilities with it. A no-op if unknown. */
  detach(id: ClientId): void {
    if (this.#clients.delete(id)) {
      this.#notify();
    }
  }

  get(id: ClientId): ConnectedClient | undefined {
    return this.#clients.get(id);
  }

  /** Every attached client, oldest first. */
  all(): ConnectedClient[] {
    return [...this.#clients.values()];
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
   * With a `client` target, that client and only that client — and only if it
   * actually handles the op, so a key bound to a Chat client never drives a
   * Meet tab that happens to share the id space.
   *
   * With no target, **last-wins**: the most recently attached claimant. That is
   * today's exact Meet behaviour, where a second Meet tab is a stale leftover.
   * Broadcasting instead would toggle the mic in a call you cannot see.
   */
  route(op: string, target?: ClientId): ConnectedClient | undefined {
    if (target !== undefined) {
      const client = this.#clients.get(target);
      return client?.ops.has(op) === true ? client : undefined;
    }
    const claimants = this.claimants(op);
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
