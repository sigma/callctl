import type { Disposer } from "../disposer.js";
import type { MeetPlugin } from "../plugins/plugin.js";
import type { Retargetable, Transport } from "./transport.js";

/**
 * A liveness snapshot across the *enabled* transports — one boolean each,
 * keyed by {@link TransportId}. A disabled transport is **absent** (not `false`),
 * so a consumer can tell "off" from "on but not connected" and the shape extends
 * cleanly to future transport ids. Produced by {@link TransportRegistry.snapshot}.
 */
export type TransportStatus = Record<string, boolean>;

/**
 * Stable ids for the transports the registry manages. Keep these stable: the
 * widget (#4), dev-bridge switch (#6) and Options port change (#7) all address
 * transports by id.
 */
export const TransportId = {
  WS: "ws",
  MIDI: "midi",
} as const;

export type TransportId = (typeof TransportId)[keyof typeof TransportId];

/**
 * Owns the live set of transports and the plugin fan-out across them — the
 * replacement for the retired static `MultiProtocol([...])` array + one-shot
 * `App.run`. Unlike `MultiProtocol` it is *not itself a `Transport`*: nothing
 * downstream needs the fan-out to look like a pipe once the registry owns it.
 *
 * The whole lifecycle is three calls:
 *  - {@link enable} builds a transport (via a caller-supplied factory) and
 *    installs every plugin onto it, once.
 *  - {@link disable} calls {@link Transport.detach} — one call undoes everything
 *    installed on it (model subscriptions, handlers, the socket).
 *  - {@link retarget} re-parameterizes a *live* transport in place, leaving its
 *    installed plugins untouched (the transparent dev-bridge/port switch).
 *
 * Every map control is just a caller: Stream Deck on/off → enable/disable("ws");
 * MIDI on/off (#5) → enable/disable("midi"); dev-bridge or Options port change
 * (#6/#7) → retarget("ws", port); MIDI device re-select (#5) → retarget("midi",
 * deviceSet).
 */
export class TransportRegistry {
  readonly #plugins: MeetPlugin[];
  readonly #live = new Map<string, Transport>();

  /** Aggregate-status subscribers (see {@link subscribe}). */
  readonly #statusListeners = new Set<() => void>();
  /** Per-transport status subscriptions, dropped when that transport is disabled. */
  readonly #statusDisposers = new Map<string, Disposer>();

  constructor(plugins: MeetPlugin[]) {
    this.#plugins = plugins;
  }

  /**
   * Build and wire a transport under `id`. Idempotent: enabling an already-live
   * id is a no-op (so it never double-installs plugins). The `factory` defers
   * construction so a disabled transport costs nothing.
   */
  enable(id: string, factory: () => Transport): void {
    if (this.#live.has(id)) {
      return;
    }
    const transport = factory();
    for (const plugin of this.#plugins) {
      transport.acceptPlugin(plugin);
    }
    this.#live.set(id, transport);
    // Forward this transport's liveness transitions into the aggregate feed, and
    // fire once now: the live set itself changed, so the snapshot did too.
    this.#statusDisposers.set(
      id,
      transport.onStatusChange(() => this.#emitStatus()),
    );
    this.#emitStatus();
  }

  /** Detach and forget the transport under `id`. A no-op if it isn't live. */
  disable(id: string): void {
    const transport = this.#live.get(id);
    if (transport === undefined) {
      return;
    }
    this.#statusDisposers.get(id)?.();
    this.#statusDisposers.delete(id);
    transport.detach();
    this.#live.delete(id);
    // The transport dropped out of the snapshot → notify.
    this.#emitStatus();
  }

  /**
   * Re-parameterize the live transport under `id` in place — no detach, no
   * plugin re-install. A no-op if the id isn't enabled or its transport isn't
   * {@link Retargetable} with this `Config`.
   */
  retarget<Config>(id: string, config: Config): void {
    const transport = this.#live.get(id) as (Transport & Partial<Retargetable<Config>>) | undefined;
    transport?.retarget?.(config);
  }

  isEnabled(id: string): boolean {
    return this.#live.has(id);
  }

  /**
   * The current liveness across enabled transports. Only live ids appear; each
   * value is that transport's {@link Transport.active}. This is the read half of
   * the narrow status port handed to the widget — never the registry itself, so
   * the widget gains a status feed but no enable/disable/retarget power.
   */
  snapshot(): TransportStatus {
    const status: TransportStatus = {};
    for (const [id, transport] of this.#live) {
      status[id] = transport.active();
    }
    return status;
  }

  /**
   * Subscribe to *aggregate* status changes — any live transport flipping active,
   * or the live set itself changing (enable/disable). Fires the change, not the
   * value; the consumer re-reads {@link snapshot}. Additive, mirroring the
   * per-transport `onStatusChange`. Returns an unsubscribe.
   */
  subscribe(onChange: () => void): Disposer {
    this.#statusListeners.add(onChange);
    return () => this.#statusListeners.delete(onChange);
  }

  #emitStatus(): void {
    for (const listener of this.#statusListeners) {
      listener();
    }
  }
}
