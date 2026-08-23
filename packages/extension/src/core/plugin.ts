import type { Transport } from "./transport/transport.js";

/**
 * A remote-control capability that installs itself onto a {@link Transport}.
 * Descendant of the legacy `Plugin` interface (via `MeetPlugin`), renamed once
 * more so it does not read as Meet-specific: this is the one interface **every**
 * surface implements, Meet and Chat alike (ADR 0002). "Plugin" here is a
 * *surface* capability, never the Stream Deck "plugin".
 *
 * {@link ID} is **identity only**. It used to double as the MIDI Control-Change
 * controller number, which is a different thing entirely — an *address* on one
 * particular transport. That address is now the opt-in {@link MidiAddressable}
 * capability, so a plugin on a surface MIDI does not reach (Chat) has nothing
 * to invent.
 */
export interface SurfacePlugin {
  /**
   * Who this plugin is, within its surface. A stable name — used for logs and
   * diagnostics, never for routing. Keep distinct across a surface's plugin set.
   */
  ID: () => string;

  /** Wire up state-change hooks that push events back over the transport. */
  installHooks: (t: Transport) => void;

  /** Register the command/query handlers this plugin answers. */
  installHandlers: (t: Transport) => void;
}

/**
 * A plugin that is additionally reachable over MIDI, at a Control-Change
 * controller number (see {@link MidiTransport} for the full dispatch mapping).
 *
 * **Opt-in.** A plugin that declares no CC number is not installed onto the MIDI
 * transport at all — its handlers would land in a `midiMap` slot no incoming
 * message could ever address, so registering them buys nothing and a made-up
 * number would make MIDI route to it by accident.
 */
export interface MidiAddressable {
  /** The CC controller number that addresses this plugin. Keep it distinct. */
  midiCC: () => number;
}

/** Does this plugin opt into MIDI addressing? */
export function isMidiAddressable(
  plugin: SurfacePlugin,
): plugin is SurfacePlugin & MidiAddressable {
  return typeof (plugin as Partial<MidiAddressable>).midiCC === "function";
}
