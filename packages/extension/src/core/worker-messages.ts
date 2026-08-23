/**
 * The extension's **internal** content-script ⇄ service-worker vocabulary.
 *
 * Deliberately separate from `@callctl/protocol`, which is the *wire* contract
 * with the Stream Deck plugin. Nothing here ever crosses the websocket: these
 * messages exist only because a handful of Chrome APIs — `chrome.windows` above
 * all — are not callable from a content script, so the worker has to do the call
 * on its behalf.
 */

/**
 * Bring the sending tab's window to the front.
 *
 * The window id is not carried: the worker reads it from `sender.tab`, which
 * Chrome fills in for a content-script message unasked. A content script that
 * told the worker which window to focus would be trusting a value it cannot
 * obtain honestly anyway.
 */
export const RAISE_WINDOW = "callctl.raiseWindow";

export interface RaiseWindowMessage {
  type: typeof RAISE_WINDOW;
}
