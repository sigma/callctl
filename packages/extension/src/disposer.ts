/**
 * Undo one thing — the value returned by every subscribe/install call that a
 * caller may later want to reverse.
 *
 * This is the primitive the live transport lifecycle turns on: an installation
 * used to be fire-and-forget (nothing to undo), so a transport could be added
 * but never cleanly removed. Handing back a `Disposer` from each install step
 * and parking it on the transport that owns it (see {@link Transport.onDetach})
 * makes enable/disable/reconfigure fall out of one add/remove path.
 */
export type Disposer = () => void;
