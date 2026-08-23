import type { AddressInfo } from "node:net";
import { Bridge } from "@callctl/bridge";
import {
  type ClientId,
  Command,
  DebugCommand,
  type DebugControl,
  DebugEvent,
  type DebugOp,
  type DebugRequest,
  type DebugResponse,
  type MeetSelectorConfig,
  type Message,
  message,
  StateEvent,
  StateValue,
} from "@callctl/protocol";
import { WebSocket as WsClient } from "ws";

export interface BridgeOptions {
  /** Port the extension dials into (the bridge listens here). */
  extensionPort: number;
  /**
   * If set, the bridge also dials the real Stream Deck plugin on this port and
   * transparently proxies traffic both ways — so Stream Deck keeps working while
   * we debug. If unset, the bridge is the sole controller (debug-only).
   */
  pluginPort?: number;
  host?: string;
  log?: (m: string) => void;
  /** How long a debug request waits for the extension before rejecting. */
  debugTimeoutMs?: number;
}

/** One attached client, as `/state` and `/clients` report it. */
export interface BridgeClient {
  id: ClientId;
  surface: string;
  label?: string;
  lang?: string;
  /** Every op it handles — the thing that decides what can be routed to it. */
  ops: string[];
}

/** Cached view of the Meet state the extension pushes, for `/state`. */
export interface BridgeState {
  extensionConnected: boolean;
  pluginConnected: boolean;
  mic: "muted" | "unmuted" | "unknown";
  camera: "muted" | "unmuted" | "unknown";
  hand: "raised" | "lowered" | "unknown";
  /** Everything attached right now. Empty when nothing is. */
  clients: BridgeClient[];
}

const RECONNECT_MS = 2000;

/**
 * The dev bridge. Two websockets:
 *  - a **server** clients dial into (`extensionPort`), and
 *  - an optional **client** to the real plugin (`pluginPort`).
 *
 * Normal command/state traffic is relayed verbatim between the two, so the
 * Stream Deck plugin behaves exactly as if it were talking to the extension
 * directly. On top of that, the bridge can inject {@link DebugCommand.Request}s
 * toward a client and correlate the {@link DebugEvent.Response}s — those debug
 * frames are intercepted and never leak up to the plugin.
 *
 * The client side is {@link Bridge}, shared with the Stream Deck plugin: this
 * used to keep exactly one connection and close the previous one, which meant
 * a Chat client and a Meet client evicted each other in a loop. Every
 * introspection entry point therefore takes an optional client — absent means
 * last-wins, so a single-client session behaves exactly as it always did.
 */
export class DebugBridge {
  readonly #opts: Required<Pick<BridgeOptions, "extensionPort" | "host" | "debugTimeoutMs">> &
    BridgeOptions;
  readonly #log: (m: string) => void;

  readonly #bridge: Bridge;
  #plugin: WsClient | null = null;
  #pluginShut = false;

  #seq = 0;
  readonly #pending = new Map<
    string,
    { resolve: (r: DebugResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  #mic: BridgeState["mic"] = "unknown";
  #camera: BridgeState["camera"] = "unknown";
  #hand: BridgeState["hand"] = "unknown";

  /** Waiters for the next `selectors` push (get/set-selectors replies). */
  readonly #selectorWaiters = new Set<(c: MeetSelectorConfig) => void>();

  constructor(opts: BridgeOptions) {
    this.#opts = {
      host: "127.0.0.1",
      debugTimeoutMs: 5000,
      ...opts,
    };
    this.#log = opts.log ?? (() => {});
    this.#bridge = new Bridge({
      port: this.#opts.extensionPort,
      host: this.#opts.host,
      log: this.#log,
    });
    this.#bridge.onMessage((m) => this.#fromClient(m));
    this.#bridge.onClientsChange(() => {
      if (this.#bridge.clients.all().length === 0) {
        this.#mic = this.#camera = "unknown";
        this.#hand = "unknown";
      }
    });
  }

  async start(): Promise<void> {
    await this.#bridge.start();
    this.#log(
      `bridge listening for clients on ${this.#opts.host}:${this.address?.port}` +
        (this.#opts.pluginPort !== undefined
          ? `, proxying plugin on :${this.#opts.pluginPort}`
          : " (debug-only, no plugin upstream)"),
    );

    if (this.#opts.pluginPort !== undefined) {
      this.#connectPlugin();
    }
  }

  close(): void {
    this.#pluginShut = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closing"));
    }
    this.#pending.clear();
    this.#selectorWaiters.clear();
    this.#bridge.close();
    this.#plugin?.close();
    this.#plugin = null;
  }

  /** The bound client-facing address once listening, or `null`. */
  get address(): AddressInfo | null {
    return this.#bridge.address;
  }

  /** Every attached client. The thing to read before targeting one. */
  get clients(): BridgeClient[] {
    return this.#bridge.clients.all().map((c) => ({
      id: c.id,
      surface: c.surface,
      ...(c.label !== undefined ? { label: c.label } : {}),
      ...(c.lang !== undefined ? { lang: c.lang } : {}),
      ops: [...c.ops],
    }));
  }

  get state(): BridgeState {
    const clients = this.clients;
    return {
      extensionConnected: clients.length > 0,
      pluginConnected: this.#plugin !== null && this.#plugin.readyState === WsClient.OPEN,
      mic: this.#mic,
      camera: this.#camera,
      hand: this.#hand,
      clients,
    };
  }

  // --- Client side -----------------------------------------------------------

  #fromClient(m: Message): void {
    // Intercept debug responses — resolve the waiting caller, do NOT forward.
    if (m.event === DebugEvent.Response) {
      this.#resolveDebug(m.data);
      return;
    }

    // Intercept selector config pushes — resolve get/set waiters. Don't forward:
    // the @callctl/plugin Stream Deck side doesn't consume `selectors` pushes.
    if (m.event === StateEvent.Selectors) {
      this.#resolveSelectors(m.data);
      return;
    }

    this.#cacheState(m);
    // Everything else (state pushes) goes up to the plugin, if proxying. The
    // source client rides along, so the plugin can tell whose state moved.
    this.#toPlugin(JSON.stringify(m));
  }

  #cacheState(m: Message): void {
    if (m.event === StateEvent.MicState) {
      this.#mic = m.data === StateValue.Muted ? "muted" : "unmuted";
    } else if (m.event === StateEvent.CameraState) {
      this.#camera = m.data === StateValue.Muted ? "muted" : "unmuted";
    } else if (m.event === StateEvent.HandState) {
      this.#hand = m.data === StateValue.Lowered ? "lowered" : "raised";
    }
  }

  // --- Plugin side (optional upstream proxy) ---------------------------------

  #connectPlugin(): void {
    const url = `ws://${this.#opts.host}:${this.#opts.pluginPort}`;
    const client = new WsClient(url);
    this.#plugin = client;

    client.on("open", () => this.#log(`connected to plugin at ${url}`));
    client.on("message", (raw) => this.#toClient(raw.toString()));
    client.on("error", () => {}); // surfaced via close/reconnect
    client.on("close", () => {
      if (this.#plugin === client) {
        this.#plugin = null;
      }
      if (!this.#pluginShut) {
        setTimeout(() => this.#connectPlugin(), RECONNECT_MS);
      }
    });
  }

  #toPlugin(raw: string): void {
    if (this.#plugin !== null && this.#plugin.readyState === WsClient.OPEN) {
      this.#plugin.send(raw);
    }
  }

  /** Relay a plugin frame down, routed by the shared registry. */
  #toClient(raw: string): void {
    let m: Message;
    try {
      m = JSON.parse(raw) as Message;
    } catch {
      this.#log(`ignoring non-JSON from plugin: ${raw}`);
      return;
    }
    this.#bridge.send(m);
  }

  // --- Debug + command injection ---------------------------------------------

  /**
   * Fire a raw command at a client (e.g. `meet.toggleHand`) as if from the
   * plugin. With no `client`, last-wins among whoever handles the op.
   */
  sendCommand(event: string, data?: string, client?: ClientId): void {
    if (!this.#bridge.send(message(event, data, client))) {
      throw new Error(this.#noClient(event, client));
    }
  }

  /** Read a client's live selector config (fires `meet.getSelectors`). */
  getSelectors(client?: ClientId): Promise<MeetSelectorConfig> {
    return this.#requestSelectors(Command.GetSelectors, undefined, client);
  }

  /** Push a partial selector override and await the merged config back. */
  setSelectors(partial: Record<string, unknown>, client?: ClientId): Promise<MeetSelectorConfig> {
    return this.#requestSelectors(Command.SetSelectors, JSON.stringify(partial), client);
  }

  #requestSelectors(event: string, data?: string, client?: ClientId): Promise<MeetSelectorConfig> {
    return new Promise<MeetSelectorConfig>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#selectorWaiters.delete(waiter);
        reject(new Error(`${event} timed out after ${this.#opts.debugTimeoutMs}ms`));
      }, this.#opts.debugTimeoutMs);
      const waiter = (config: MeetSelectorConfig) => {
        clearTimeout(timer);
        resolve(config);
      };
      this.#selectorWaiters.add(waiter);
      if (!this.#bridge.send(message(event, data, client))) {
        clearTimeout(timer);
        this.#selectorWaiters.delete(waiter);
        reject(new Error(this.#noClient(event, client)));
      }
    });
  }

  #resolveSelectors(data: string | undefined): void {
    let config: MeetSelectorConfig;
    try {
      config = JSON.parse(data ?? "{}") as MeetSelectorConfig;
    } catch {
      this.#log(`ignoring malformed selectors push: ${data}`);
      return;
    }
    const waiters = [...this.#selectorWaiters];
    this.#selectorWaiters.clear();
    for (const w of waiters) {
      w(config);
    }
  }

  /**
   * Run a debug op against a client's live DOM and await its reply. With no
   * `client`, last-wins — which, with only one attached, is that one.
   */
  debug(op: DebugOp, arg?: string, client?: ClientId): Promise<DebugResponse> {
    const id = `d${++this.#seq}`;
    const req: DebugRequest = { id, op, arg };

    return new Promise<DebugResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`debug ${op} timed out after ${this.#opts.debugTimeoutMs}ms`));
      }, this.#opts.debugTimeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      const sent = this.#bridge.send(message(DebugCommand.Request, JSON.stringify(req), client));
      if (!sent) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(this.#noClient(`debug ${op}`, client)));
      }
    });
  }

  #resolveDebug(data: string | undefined): void {
    let res: DebugResponse;
    try {
      res = JSON.parse(data ?? "{}") as DebugResponse;
    } catch {
      this.#log(`ignoring malformed debug response: ${data}`);
      return;
    }
    const pending = this.#pending.get(res.id);
    if (pending === undefined) {
      this.#log(`debug response with no matching request: ${res.id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(res.id);
    pending.resolve(res);
  }

  /**
   * Why nothing took a frame. Distinguishes "nobody is here" from "the client
   * you named cannot do that" — the debug surface only registers in non-
   * production extension builds, so "connected but no `debugRequest`" is a
   * routine and otherwise baffling case.
   */
  #noClient(what: string, client?: ClientId): string {
    if (this.#bridge.clients.all().length === 0) {
      return `no extension connected (${what})`;
    }
    if (client !== undefined) {
      return `client ${client} is not attached, or does not handle ${what}`;
    }
    return `no attached client handles ${what}`;
  }
}

export type { DebugControl, DebugResponse };
