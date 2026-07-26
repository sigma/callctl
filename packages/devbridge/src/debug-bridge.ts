import type { AddressInfo } from "node:net";
import {
  DebugCommand,
  type DebugControl,
  DebugEvent,
  type DebugOp,
  type DebugRequest,
  type DebugResponse,
  type Message,
  message,
  StateEvent,
  StateValue,
} from "@meetdeck/protocol";
import { type WebSocket, WebSocketServer, WebSocket as WsClient } from "ws";

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

/** Cached view of the Meet state the extension pushes, for `/state`. */
export interface BridgeState {
  extensionConnected: boolean;
  pluginConnected: boolean;
  mic: "muted" | "unmuted" | "unknown";
  camera: "muted" | "unmuted" | "unknown";
  hand: "raised" | "lowered" | "unknown";
}

const RECONNECT_MS = 2000;

/**
 * The dev bridge. Two websockets:
 *  - a **server** the extension dials into (`extensionPort`), and
 *  - an optional **client** to the real plugin (`pluginPort`).
 *
 * Normal command/state traffic is relayed verbatim between the two, so the
 * Stream Deck plugin behaves exactly as if it were talking to the extension
 * directly. On top of that, the bridge can inject {@link DebugCommand.Request}s
 * toward the extension and correlate the {@link DebugEvent.Response}s — those
 * debug frames are intercepted and never leak up to the plugin.
 */
export class DebugBridge {
  readonly #opts: Required<Pick<BridgeOptions, "extensionPort" | "host" | "debugTimeoutMs">> &
    BridgeOptions;
  readonly #log: (m: string) => void;

  #wss: WebSocketServer | null = null;
  #ext: WebSocket | null = null;
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

  constructor(opts: BridgeOptions) {
    this.#opts = {
      host: "127.0.0.1",
      debugTimeoutMs: 5000,
      ...opts,
    };
    this.#log = opts.log ?? (() => {});
  }

  start(): Promise<void> {
    const wss = new WebSocketServer({ host: this.#opts.host, port: this.#opts.extensionPort });
    this.#wss = wss;
    wss.on("connection", (conn) => this.#onExtension(conn));

    if (this.#opts.pluginPort !== undefined) {
      this.#connectPlugin();
    }

    return new Promise((resolve, reject) => {
      wss.once("listening", () => {
        this.#log(
          `bridge listening for extension on ${this.#opts.host}:${this.#opts.extensionPort}` +
            (this.#opts.pluginPort !== undefined
              ? `, proxying plugin on :${this.#opts.pluginPort}`
              : " (debug-only, no plugin upstream)"),
        );
        wss.on("error", (err) => this.#log(`server error: ${err.message}`));
        resolve();
      });
      wss.once("error", reject);
    });
  }

  close(): void {
    this.#pluginShut = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closing"));
    }
    this.#pending.clear();
    this.#ext?.close();
    this.#plugin?.close();
    this.#wss?.close();
    this.#ext = null;
    this.#plugin = null;
    this.#wss = null;
  }

  /** The bound extension-facing address once listening, or `null`. */
  get address(): AddressInfo | null {
    const a = this.#wss?.address();
    return a !== undefined && typeof a !== "string" ? a : null;
  }

  get state(): BridgeState {
    return {
      extensionConnected: this.#ext !== null,
      pluginConnected: this.#plugin !== null && this.#plugin.readyState === WsClient.OPEN,
      mic: this.#mic,
      camera: this.#camera,
      hand: this.#hand,
    };
  }

  // --- Extension side --------------------------------------------------------

  #onExtension(conn: WebSocket): void {
    this.#log("extension connected");
    this.#ext?.close();
    this.#ext = conn;

    conn.on("message", (raw) => this.#fromExtension(raw.toString()));
    conn.on("close", () => {
      if (this.#ext === conn) {
        this.#ext = null;
        this.#mic = this.#camera = "unknown";
        this.#hand = "unknown";
        this.#log("extension disconnected");
      }
    });
    conn.on("error", (err) => this.#log(`extension error: ${err.message}`));
  }

  #fromExtension(raw: string): void {
    let m: Message;
    try {
      m = JSON.parse(raw) as Message;
    } catch {
      this.#log(`ignoring non-JSON from extension: ${raw}`);
      return;
    }

    // Intercept debug responses — resolve the waiting caller, do NOT forward.
    if (m.event === DebugEvent.Response) {
      this.#resolveDebug(m.data);
      return;
    }

    this.#cacheState(m);
    // Everything else (state pushes) goes up to the plugin, if proxying.
    this.#toPlugin(raw);
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
    client.on("message", (raw) => this.#toExtension(raw.toString()));
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

  #toExtension(raw: string): void {
    if (this.#ext !== null && this.#ext.readyState === WsClient.OPEN) {
      this.#ext.send(raw);
    }
  }

  // --- Debug + command injection ---------------------------------------------

  /** Fire a raw command at the extension (e.g. `toggleHand`) as if from the plugin. */
  sendCommand(event: string, data?: string): void {
    if (this.#ext === null) {
      throw new Error("no extension connected");
    }
    this.#ext.send(JSON.stringify(message(event, data)));
  }

  /** Run a debug op against the live Meet DOM and await the extension's reply. */
  debug(op: DebugOp, arg?: string): Promise<DebugResponse> {
    if (this.#ext === null) {
      return Promise.reject(new Error("no extension connected"));
    }
    const id = `d${++this.#seq}`;
    const req: DebugRequest = { id, op, arg };

    return new Promise<DebugResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`debug ${op} timed out after ${this.#opts.debugTimeoutMs}ms`));
      }, this.#opts.debugTimeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      (this.#ext as WebSocket).send(
        JSON.stringify(message(DebugCommand.Request, JSON.stringify(req))),
      );
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
}

export type { DebugControl, DebugResponse };
