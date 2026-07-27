import type { AddressInfo } from "node:net";
import {
  Command,
  DEFAULT_PORT,
  type Message,
  message,
  type ReactionSlug,
  reactionLabel,
  StateEvent,
  StateValue,
} from "@callctl/protocol";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * A callback notified whenever the remote's connection or cached Meet state
 * changes. Registered via {@link MeetRemote.onStateChange}; the returned
 * function unsubscribes it.
 */
export type StateChangeListener = () => void;

/**
 * The local websocket **server** end of the Meet remote-control protocol — the
 * plugin listens, the Chrome extension dials in as the client.
 *
 * Faithful port of `meetremote.Remote` (Go). It owns the socket, caches the
 * mic/camera/hand state pushed by the extension, and fans changes out to
 * listeners (the Stream Deck toggle actions). All wire vocabulary comes from
 * `@callctl/protocol` — never hand-write event strings here.
 *
 * Only one extension connection is kept at a time; a fresh dial-in replaces the
 * previous socket, matching the Go behaviour.
 */
export class MeetRemote {
  readonly #port: number;
  readonly #log: (message: string) => void;

  #wss: WebSocketServer | null = null;
  #conn: WebSocket | null = null;

  // Cached Meet state. Named to mirror the Go zero-values exactly: a fresh
  // remote assumes mic/camera on (not muted) and hand not lowered. On every
  // (re)connect we immediately query the real state, so these defaults only
  // ever show in the brief window before the extension answers.
  #micOff = false;
  #cameraOff = false;
  #handLowered = false;
  // Captions have no Go precedent; they default off, which is Meet's own
  // default. Like the others, we query the real state on connect.
  #captionsOff = true;

  readonly #inputHandlers: Record<string, (data: string | undefined) => void>;
  readonly #listeners = new Set<StateChangeListener>();

  constructor(opts: { port?: number; log?: (message: string) => void } = {}) {
    this.#port = opts.port ?? DEFAULT_PORT;
    this.#log = opts.log ?? (() => {});

    // Inbound state pushes from the extension update the cache. Mirrors the Go
    // `defaultInputHandlers` map (api.go + google_hand.go).
    this.#inputHandlers = {
      [StateEvent.MicState]: (data) => {
        this.#micOff = data === StateValue.Muted;
      },
      [StateEvent.CameraState]: (data) => {
        this.#cameraOff = data === StateValue.Muted;
      },
      [StateEvent.HandState]: (data) => {
        this.#handLowered = data === StateValue.Lowered;
      },
      [StateEvent.CaptionsState]: (data) => {
        this.#captionsOff = data === StateValue.CaptionsOff;
      },
    };
  }

  /**
   * Start listening for the extension to dial in. The returned promise resolves
   * once the server is bound (or rejects if the port is unavailable). Safe to
   * call once; a second call resolves immediately.
   */
  start(): Promise<void> {
    if (this.#wss !== null) {
      return Promise.resolve();
    }

    // Bind loopback only — the bridge is strictly local (Go listened on
    // localhost:2395).
    const wss = new WebSocketServer({ host: "127.0.0.1", port: this.#port });
    this.#wss = wss;

    wss.on("connection", (conn) => this.#onConnection(conn));

    return new Promise((resolve, reject) => {
      wss.once("listening", () => {
        this.#log(`remote listening on 127.0.0.1:${this.address?.port}`);
        wss.on("error", (err) => this.#log(`remote server error: ${err.message}`));
        resolve();
      });
      wss.once("error", reject);
    });
  }

  /** The bound address once listening, or `null`. Mirrors Go's resolved `addr`. */
  get address(): AddressInfo | null {
    const a = this.#wss?.address();
    return a !== undefined && typeof a !== "string" ? a : null;
  }

  /** Stop listening and drop any live connection. */
  close(): void {
    this.#conn?.close();
    this.#conn = null;
    this.#wss?.close();
    this.#wss = null;
  }

  #onConnection(conn: WebSocket): void {
    this.#log("extension connected");

    // Keep a single connection: a new dial-in supersedes the old socket.
    if (this.#conn !== null) {
      this.#conn.close();
    }
    this.#conn = conn;

    conn.on("message", (raw) => this.#processInput(raw.toString()));
    conn.on("close", () => {
      if (this.#conn === conn) {
        this.#conn = null;
        this.#log("extension disconnected");
        this.#notifyStateChange();
      }
    });
    conn.on("error", (err) => this.#log(`connection error: ${err.message}`));

    // On (re)connect, ask Meet for the current state so the LEDs are accurate
    // rather than showing our stale defaults (Go called Ask*State here).
    this.#notifyStateChange();
    this.askMicState();
    this.askCameraState();
    this.askHandState();
    this.askCaptionsState();
  }

  #processInput(raw: string): void {
    let m: Message;
    try {
      m = JSON.parse(raw) as Message;
    } catch {
      this.#log(`ignoring non-JSON message: ${raw}`);
      return;
    }

    const handler = this.#inputHandlers[m.event];
    if (handler === undefined) {
      this.#log(`unknown event: ${m.event}`);
      return;
    }

    this.#log(`${m.event} = ${m.data}`);
    handler(m.data);
    this.#notifyStateChange();
  }

  #send(event: string, data?: string): void {
    if (this.#conn === null) {
      this.#log(`dropping ${event}: remote is not paired`);
      return;
    }
    this.#conn.send(JSON.stringify(message(event, data)));
  }

  // --- State change fan-out --------------------------------------------------

  /** Subscribe to connection/state changes; returns an unsubscribe function. */
  onStateChange(listener: StateChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notifyStateChange(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        this.#log(`state-change listener threw: ${(err as Error).message}`);
      }
    }
  }

  // --- Remote "LEDs" (state readers, mirroring Go semantics) -----------------

  /** Whether the extension is currently connected. */
  get connected(): boolean {
    return this.#conn !== null;
  }

  /** Mic is on (unmuted). Mirrors Go `MicState()`. */
  micState(): boolean {
    return !this.#micOff;
  }

  /** Camera is on (enabled). Mirrors Go `CameraState()`. */
  cameraState(): boolean {
    return !this.#cameraOff;
  }

  /**
   * Mirrors Go `HandState()`, which returns whether the hand is *lowered* (note
   * the asymmetry with mic/camera, whose readers return the *on* state). The
   * hand-toggle action's on/off images are staged to match this.
   */
  handState(): boolean {
    return this.#handLowered;
  }

  /**
   * Captions are on. Mirrors the mic/camera readers (returns the *on* state, not
   * the hand-style inverted one). The captions-toggle action's on/off images are
   * staged to match.
   */
  captionsState(): boolean {
    return !this.#captionsOff;
  }

  // --- Remote "buttons" (commands, mirroring Go method names) ----------------

  leave(): void {
    this.#send(Command.LeaveCall);
  }

  muteMic(): void {
    this.#send(Command.MuteMic);
  }

  unmuteMic(): void {
    this.#send(Command.UnmuteMic);
  }

  toggleMic(): void {
    this.#send(Command.ToggleMic);
  }

  askMicState(): void {
    this.#send(Command.GetMicState);
  }

  disableCamera(): void {
    this.#send(Command.DisableCamera);
  }

  enableCamera(): void {
    this.#send(Command.EnableCamera);
  }

  toggleCamera(): void {
    this.#send(Command.ToggleCamera);
  }

  askCameraState(): void {
    this.#send(Command.GetCameraState);
  }

  toggleParticipants(): void {
    this.#send(Command.ToggleParticipants);
  }

  toggleChat(): void {
    this.#send(Command.ToggleChat);
  }

  raiseHand(): void {
    this.#send(Command.RaiseHand);
  }

  lowerHand(): void {
    this.#send(Command.LowerHand);
  }

  toggleHand(): void {
    this.#send(Command.ToggleHand);
  }

  askHandState(): void {
    this.#send(Command.GetHandState);
  }

  enableCaptions(): void {
    this.#send(Command.EnableCaptions);
  }

  disableCaptions(): void {
    this.#send(Command.DisableCaptions);
  }

  toggleCaptions(): void {
    this.#send(Command.ToggleCaptions);
  }

  askCaptionsState(): void {
    this.#send(Command.GetCaptionsState);
  }

  /** Send a reaction. `data` is the Meet alt-text label for the slug. */
  react(slug: ReactionSlug): void {
    this.#send(Command.React, reactionLabel(slug));
  }
}
