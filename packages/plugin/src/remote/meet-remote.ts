import type { AddressInfo } from "node:net";
import { Bridge } from "@callctl/bridge";
import {
  type ClientId,
  Command,
  DEFAULT_PORT,
  type Message,
  message,
  type ReactionSlug,
  reactionLabel,
  StateEvent,
  StateValue,
} from "@callctl/protocol";

/**
 * A callback notified whenever the remote's connection or cached Meet state
 * changes. Registered via {@link MeetRemote.onStateChange}; the returned
 * function unsubscribes it.
 */
export type StateChangeListener = () => void;

/**
 * The op that means "a Meet client is attached".
 *
 * Presence is a **per-capability** question now, not a per-socket one (ADR
 * 0001): with a Chat window also dialled in, "is a socket open?" answers yes
 * while Meet is nowhere to be found. Any Meet op would serve; this one is the
 * surface's most characteristic, and it is derived from the same handshake the
 * routing reads, so it cannot drift from the ops that actually exist.
 */
const MEET_PRESENCE_OP: string = Command.ToggleMic;

/**
 * The Meet half of the local bridge — the plugin listens, the Chrome extension
 * dials in as a client.
 *
 * Descendant of `meetremote.Remote` (Go), now sitting on top of
 * {@link Bridge}: sockets, handshakes, the client registry and routing belong
 * there and are surface-neutral, while this class owns only Meet state and its
 * typed accessors. A future `ChatRemote` sits beside it, over the same bridge.
 * All wire vocabulary comes from `@callctl/protocol` — never hand-write event
 * strings here.
 *
 * Routing is last-wins with no explicit target, which is Meet's exact former
 * behaviour: you cannot be in two calls, so a second Meet tab is a stale
 * leftover and the newest one is the one you mean.
 */
export class MeetRemote {
  readonly #bridge: Bridge;
  readonly #log: (message: string) => void;

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
  // Optional §10 join-detection: the provider-namespaced code of the call the
  // extension reports you are *in* (e.g. "gmeet:abc-def-ghi"), or null when not
  // in a call / no extension present. Read-only — never drives Meet. Reset to
  // null on disconnect so a stale key can't keep dismissing the late state.
  #joinedKey: string | null = null;

  readonly #inputHandlers: Record<string, (data: string | undefined) => void>;
  readonly #listeners = new Set<StateChangeListener>();

  constructor(opts: { port?: number; log?: (message: string) => void } = {}) {
    this.#log = opts.log ?? (() => {});
    this.#bridge = new Bridge({ port: opts.port ?? DEFAULT_PORT, log: this.#log });

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
      // §10: "joined" carries the namespaced code; "not in a call" arrives with
      // no data (or empty) → null. Additive read-only cache, like the others.
      [StateEvent.CallState]: (data) => {
        this.#joinedKey = data ? data : null;
      },
    };

    this.#wire();
  }

  /**
   * Start listening for clients to dial in. The returned promise resolves once
   * the bridge is bound (or rejects if the port is unavailable).
   */
  start(): Promise<void> {
    return this.#bridge.start();
  }

  /** The bound address once listening, or `null`. Mirrors Go's resolved `addr`. */
  get address(): AddressInfo | null {
    return this.#bridge.address;
  }

  /** Stop listening and drop every attached client. */
  close(): void {
    this.#bridge.close();
  }

  #wire(): void {
    this.#bridge.onMessage((m) => this.#onMessage(m));

    // The attached set changing is a state change from a key's point of view:
    // Meet arriving lights the LEDs, Meet leaving must dim them.
    this.#bridge.onClientsChange(() => {
      if (!this.connected) {
        // Drop join-proof: with no Meet client we can no longer detect a call,
        // so a stale key must not keep dismissing the late state (§10).
        this.#joinedKey = null;
        this.#notifyStateChange();
        return;
      }
      // On (re)connect, ask Meet for the current state so the LEDs are accurate
      // rather than showing our stale defaults (Go called Ask*State here).
      this.#notifyStateChange();
      this.askMicState();
      this.askCameraState();
      this.askHandState();
      this.askCaptionsState();
    });
  }

  #onMessage(m: Message): void {
    const handler = this.#inputHandlers[m.event];
    if (handler === undefined) {
      // Not ours — a Chat client's roster push travels the same bridge.
      return;
    }

    // Only the client we would *send* to may move our state. Otherwise a second
    // Meet tab, left open on a call you are not in, silently overwrites the
    // LEDs for the tab the commands are actually reaching.
    if (m.client !== undefined && m.client !== this.#target()) {
      return;
    }

    this.#log(`${m.event} = ${m.data}`);
    handler(m.data);
    this.#notifyStateChange();
  }

  /** Which client Meet commands currently reach: last-wins among claimants. */
  #target(): ClientId | undefined {
    return this.#bridge.clients.route(MEET_PRESENCE_OP)?.id;
  }

  #send(event: string, data?: string): void {
    this.#bridge.send(message(event, data));
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

  /**
   * Whether a **Meet** client is attached.
   *
   * Per-capability on purpose: with the bridge holding several clients, "a
   * socket is open" is no longer the same question — a Chat window alone must
   * leave every Meet key dark.
   */
  get connected(): boolean {
    return this.#bridge.handles(MEET_PRESENCE_OP);
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

  /**
   * The optional §10 join-detection key: the provider-namespaced canonical code
   * of the call the extension reports you are currently *in* (e.g.
   * `"gmeet:abc-def-ghi"`), or `null` when not in a call, when no extension is
   * connected, or when the extension is absent entirely. `NextMeetingAction`
   * matches this against its tracked events to dismiss the late state on join.
   */
  joinedKey(): string | null {
    return this.#joinedKey;
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
