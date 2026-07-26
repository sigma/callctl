import type { Transport } from "../transport/transport.js";

/**
 * A remote-control capability that installs itself onto a {@link Transport}.
 * Faithful port of the legacy `Plugin` interface (renamed to `MeetPlugin` to
 * avoid confusion with the Stream Deck "plugin").
 *
 * `ID()` doubles as the MIDI CC selector (see {@link MidiProtocol}); keep the
 * numeric ids stable and distinct across plugins.
 */
export interface MeetPlugin {
  ID: () => number;

  /** Wire up state-change hooks that push events back over the transport. */
  installHooks: (t: Transport) => void;

  /** Register the command/query handlers this plugin answers. */
  installHandlers: (t: Transport) => void;
}
