import type { MeetPlugin } from "../plugins/plugin.js";
import type { Retargetable, Transport } from "./transport.js";

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
  }

  /** Detach and forget the transport under `id`. A no-op if it isn't live. */
  disable(id: string): void {
    const transport = this.#live.get(id);
    if (transport === undefined) {
      return;
    }
    transport.detach();
    this.#live.delete(id);
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
}
