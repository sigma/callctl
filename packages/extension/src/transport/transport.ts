import type { Message } from "@callctl/protocol";
import type { Disposer } from "../disposer.js";
import type { MeetPlugin } from "../plugins/plugin.js";

export type { Message };

/**
 * A bidirectional link between the extension and some controller.
 *
 * This is the legacy `Protocol` interface, renamed to `Transport` so it no
 * longer collides with the shared `@callctl/protocol` package (which owns the
 * *wire vocabulary* — event names, reaction labels, the `Message` envelope).
 * A `Transport` is the *pipe*; the vocabulary flowing through it comes from
 * `@callctl/protocol`.
 *
 * A transport is the unit of the runtime lifecycle: it can be enabled, disabled
 * and reconfigured live (see {@link TransportRegistry}), with no Meet-tab
 * reload. To make "disable" clean, a transport *owns everything installed on
 * it*: every install step parks a {@link Disposer} via {@link onDetach}, and
 * {@link detach} runs them all (undoing model subscriptions, handlers, and the
 * pipe itself). This replaces the old fire-and-forget `shutdown` — a transport
 * that could stop reconnecting but never actually un-wire itself.
 *
 * Concrete transports: {@link WSTransport} (the Stream Deck bridge websocket),
 * {@link MidiTransport} (Web MIDI input). The fan-out across several of them is
 * owned by {@link TransportRegistry}, not a transport (the retired
 * `MultiProtocol`).
 */
export interface Transport {
  /** Called once the transport is ready to carry traffic (e.g. ws opened). */
  onConnect: () => void;

  /** Push a message to the controller (state events flow this way). */
  send: (message: Message) => void;

  /** Register a handler for an inbound command/query keyed by event name. */
  handle: (op: string, h: (msg: Message) => void) => void;

  /** Let a plugin install its hooks + handlers onto this transport. */
  acceptPlugin: (plugin: MeetPlugin) => void;

  /**
   * Park a {@link Disposer} to be run when this transport is detached. The sink
   * every install step routes its cleanup through — a model subscription's
   * unsubscribe, a handler's removal, anything else that must be undone.
   */
  onDetach: (d: Disposer) => void;

  /**
   * Reversible, *permanent-for-this-instance* teardown: run every parked
   * disposer, then close the pipe (stop reconnecting). Re-enabling builds a
   * fresh instance. Subsumes the old `shutdown`.
   */
  detach: () => void;
}

/**
 * A transport that can be re-parameterized *in place* while live — no teardown,
 * no plugin re-install. `Config` is per-transport: the websocket takes a new
 * port ({@link WSTransport.retarget}); MIDI (see #5) takes the checked device
 * set. The registry stays generic over it (see {@link TransportRegistry.retarget}).
 */
export interface Retargetable<Config> {
  retarget: (config: Config) => void;
}

/**
 * Shared base giving any transport its disposer sink + `detach` skeleton, so
 * each concrete transport only has to say how it sends and how it closes its
 * pipe. Handler removal is *self-parked*: a transport's `handle` registers the
 * handler and immediately parks its own removal via {@link onDetach}, so
 * `detach` clears handlers for free.
 */
export abstract class BaseTransport implements Transport {
  onConnect: () => void = () => {};

  readonly #disposers = new Set<Disposer>();

  onDetach(d: Disposer): void {
    this.#disposers.add(d);
  }

  detach(): void {
    for (const d of this.#disposers) {
      d();
    }
    this.#disposers.clear();
    this.close();
  }

  acceptPlugin(plugin: MeetPlugin): void {
    plugin.installHooks(this);
    plugin.installHandlers(this);
  }

  abstract send(message: Message): void;
  abstract handle(op: string, h: (msg: Message) => void): void;

  /** Transport-specific pipe teardown (close the socket, unbind MIDI inputs…). */
  protected abstract close(): void;
}
