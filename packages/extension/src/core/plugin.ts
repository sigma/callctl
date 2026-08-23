import type { Transport } from "./transport/transport.js";

/**
 * A remote-control capability that installs itself onto a {@link Transport}.
 * Descendant of the legacy `Plugin` interface (via `MeetPlugin`), renamed once
 * more so it does not read as Meet-specific: this is the one interface **every**
 * surface implements, Meet and Chat alike (ADR 0002). "Plugin" here is a
 * *surface* capability, never the Stream Deck "plugin".
 */
export interface SurfacePlugin {
  ID: () => number;

  /** Wire up state-change hooks that push events back over the transport. */
  installHooks: (t: Transport) => void;

  /** Register the command/query handlers this plugin answers. */
  installHandlers: (t: Transport) => void;
}
