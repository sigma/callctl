import { ChatCommand } from "@callctl/protocol";
import type { SurfacePlugin } from "../core/plugin.js";
import type { Transport } from "../core/transport/transport.js";
import { RAISE_WINDOW, type RaiseWindowMessage } from "../core/worker-messages.js";

/**
 * How the raise actually happens. Injected because the real one is a Chrome API
 * with no test double, and because the indirection *is* the interesting part:
 * `chrome.windows` cannot be called from a content script, so this hands off to
 * the service worker rather than doing the work itself.
 */
export type RaiseWindow = () => void;

/** The real one: ask the service worker to focus this tab's window. */
export const messageWorkerToRaise: RaiseWindow = () => {
  const message: RaiseWindowMessage = { type: RAISE_WINDOW };
  void chrome.runtime.sendMessage(message);
};

/**
 * Brings this Chat window to the front on `chat.raise`.
 *
 * **No arguments, and no navigation.** Press raises the window; whatever
 * conversation is on screen stays on screen. The future paging key adds an
 * optional conversation target to this same command *additively*, so shipping
 * the field now would be unused API inviting use before its semantics are
 * settled.
 */
class RaisePlugin implements SurfacePlugin {
  readonly #raise: RaiseWindow;

  constructor(raise: RaiseWindow) {
    this.#raise = raise;
  }

  ID(): string {
    return "raise";
  }

  // No hooks: nothing to push, and in particular `t.onConnect` belongs to the
  // roster plugin — a second setter would silence the on-connect roster push.
  installHooks(_t: Transport): void {}

  installHandlers(t: Transport): void {
    t.handle(ChatCommand.Raise, () => this.#raise());
  }
}

export function newRaisePlugin(raise: RaiseWindow = messageWorkerToRaise): SurfacePlugin {
  console.log("loading chat raise plugin");
  return new RaisePlugin(raise);
}
