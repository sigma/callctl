import type { Bridge } from "@callctl/bridge";
import {
  ChatCommand,
  ChatEvent,
  type ChatRoster,
  type ClientId,
  type Message,
  message,
} from "@callctl/protocol";

/** A callback notified whenever an attached Chat client or its roster changes. */
export type ChatChangeListener = () => void;

/**
 * The op that means "this client is a Chat client".
 *
 * Presence is asked **per capability** (ADR 0001), never per socket: a Meet tab
 * being open must not light a Chat key, and vice versa.
 */
const CHAT_PRESENCE_OP: string = ChatCommand.GetRoster;

/** One attached Chat client, as a key or the Property Inspector sees it. */
export interface ChatClient {
  id: ClientId;
  /** Its human name — the account's **full** domain, when it knows one. */
  label: string;
}

/**
 * The Chat half of the local bridge: which Chat clients are attached, what each
 * one's unread roster is, and how to raise one.
 *
 * Sits beside {@link MeetRemote} over the same {@link Bridge}, owning only Chat
 * state — the split ADR 0001 called for. Two Chat windows are a **first-class**
 * case (a work Chrome profile and a personal one), so everything here is keyed
 * by client rather than collapsed to a single "connected" flag.
 */
export class ChatRemote {
  readonly #bridge: Bridge;
  readonly #log: (message: string) => void;

  /** Latest roster per client. Dropped the moment a client detaches. */
  readonly #rosters = new Map<ClientId, ChatRoster>();

  /**
   * Last-known-good label per client, kept across detach.
   *
   * A client may handshake before it can name itself — Chat's account anchor
   * resolves late — and it may go away while a key is still bound to it.
   * Forgetting the name in either case would turn a bound key into an opaque id
   * in the Property Inspector, so the cache outlives the connection.
   */
  readonly #labels = new Map<ClientId, string>();

  readonly #listeners = new Set<ChatChangeListener>();

  constructor(opts: { bridge: Bridge; log?: (message: string) => void }) {
    this.#bridge = opts.bridge;
    this.#log = opts.log ?? (() => {});

    this.#bridge.onMessage((m) => this.#onMessage(m));
    this.#bridge.onClientsChange(() => {
      this.#reconcile();
      this.#notify();
    });
  }

  /** Every attached Chat client, oldest first. What the PI dropdown lists. */
  clients(): ChatClient[] {
    return this.#bridge.clients
      .claimants(CHAT_PRESENCE_OP)
      .map((c) => ({ id: c.id, label: this.#labelFor(c.id, c.label) }));
  }

  /**
   * Which client a key's binding resolves to right now, or `undefined`.
   *
   * **Unbound means "any client with this capability"**, so a single-account
   * setup is zero-configuration: install, add a key, done. A binding to a client
   * that is not attached resolves to nothing — deliberately *not* to some other
   * client, which would silently point the key at the wrong account.
   */
  resolve(clientId?: ClientId): ClientId | undefined {
    if (clientId !== undefined && clientId !== "") {
      const client = this.#bridge.clients.get(clientId);
      return client?.ops.has(CHAT_PRESENCE_OP) === true ? client.id : undefined;
    }
    return this.#bridge.clients.route(CHAT_PRESENCE_OP)?.id;
  }

  /** The best name we have for a client, attached or not. */
  labelOf(clientId?: ClientId): string | undefined {
    if (clientId === undefined || clientId === "") {
      const resolved = this.resolve();
      return resolved === undefined ? undefined : this.#labels.get(resolved);
    }
    return this.#labels.get(clientId);
  }

  /**
   * The unread roster for a binding, or `null` when no such client is attached.
   *
   * `null` is not an empty roster: it is the "no client" state, which the key
   * must render distinctly. **A stale count is never shown** — a client going
   * away discards its roster rather than freezing the last number on the key.
   */
  roster(clientId?: ClientId): ChatRoster | null {
    const resolved = this.resolve(clientId);
    if (resolved === undefined) {
      return null;
    }
    return this.#rosters.get(resolved) ?? { conversations: [] };
  }

  /**
   * How many conversations the key should badge, or `null` for no client.
   *
   * **Unread *and notifying*** — muted entries are reported but never counted.
   * Muting is a deliberate statement that a space should not interrupt, and a
   * deck key is an interrupting surface. Never a message count: no trustworthy
   * one exists.
   */
  unreadCount(clientId?: ClientId): number | null {
    const roster = this.roster(clientId);
    return roster === null ? null : roster.conversations.filter((c) => !c.muted).length;
  }

  /** Bring a client's Chat window to the front. Silent if it is not attached. */
  raise(clientId?: ClientId): boolean {
    const resolved = this.resolve(clientId);
    if (resolved === undefined) {
      return false;
    }
    return this.#bridge.send(message(ChatCommand.Raise, undefined, resolved));
  }

  /** Ask a client to re-send its roster. Routine operation is push-driven. */
  askRoster(clientId?: ClientId): void {
    const resolved = this.resolve(clientId);
    if (resolved !== undefined) {
      this.#bridge.send(message(ChatCommand.GetRoster, undefined, resolved));
    }
  }

  /** Subscribe to client-set or roster changes; returns an unsubscribe. */
  onChange(listener: ChatChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #onMessage(m: Message): void {
    if (m.event !== ChatEvent.Roster || m.client === undefined) {
      return;
    }
    let roster: ChatRoster;
    try {
      roster = JSON.parse(m.data ?? "{}") as ChatRoster;
    } catch {
      this.#log(`ignoring malformed chat roster from ${m.client}`);
      return;
    }
    this.#rosters.set(m.client, { conversations: roster.conversations ?? [] });
    this.#notify();
  }

  /** Drop state for clients that went away; refresh the label cache. */
  #reconcile(): void {
    const attached = new Set(this.#bridge.clients.all().map((c) => c.id));
    for (const id of [...this.#rosters.keys()]) {
      if (!attached.has(id)) {
        // Never show a stale count.
        this.#rosters.delete(id);
      }
    }
    for (const client of this.#bridge.clients.claimants(CHAT_PRESENCE_OP)) {
      if (client.label !== undefined && client.label !== "") {
        this.#labels.set(client.id, client.label);
      }
    }
  }

  #labelFor(id: ClientId, live: string | undefined): string {
    if (live !== undefined && live !== "") {
      return live;
    }
    return this.#labels.get(id) ?? id;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        this.#log(`chat listener threw: ${(err as Error).message}`);
      }
    }
  }
}
