import type { SelectorConfig } from "@callctl/protocol";
import { Command, message, StateEvent } from "@callctl/protocol";
import { type SelectorRegistry, selectors } from "../meet/selectors.js";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Config-over-the-wire selectors. Lets the controller (the Stream Deck plugin,
 * or the dev bridge) read and reconfigure the Meet match strings at runtime, so
 * a selector that Google renamed can be fixed with a `setSelectors` push instead
 * of a content-script rebuild + tab reload (which drops the call).
 *
 * Unlike the DebugPlugin this is **not** dev-only: fixing drift in the field
 * without republishing the extension is a first-class capability.
 *
 * Wire protocol:
 *   ← { event: "getSelectors" }                     → push current full config
 *   ← { event: "setSelectors", data: <partial JSON> } → merge, persist, push back
 *   → { event: "selectors", data: <full config JSON> }
 */
export type PersistSelectors = (config: SelectorConfig) => void;

class SelectorsPlugin implements MeetPlugin {
  readonly #registry: SelectorRegistry;
  readonly #persist: PersistSelectors;

  constructor(registry: SelectorRegistry = selectors, persist: PersistSelectors = () => {}) {
    this.#registry = registry;
    this.#persist = persist;
  }

  ID(): number {
    return 2;
  }

  // No hooks: this plugin has no autonomous push. In particular it must NOT set
  // `t.onConnect` (a single settable field the CorePlugin already owns — a
  // second setter would clobber the mute-state transmit on reconnect).
  installHooks(_t: Transport): void {}

  installHandlers(t: Transport): void {
    const push = () => t.send(message(StateEvent.Selectors, JSON.stringify(this.#registry.all())));

    t.handle(Command.GetSelectors, () => push());

    t.handle(Command.SetSelectors, (msg) => {
      let partial: Partial<Record<string, unknown>>;
      try {
        partial = JSON.parse(msg.data ?? "{}") as Partial<Record<string, unknown>>;
      } catch {
        return; // malformed push — ignore rather than blank out selectors
      }
      const next = this.#registry.apply(partial);
      this.#persist(next);
      push();
    });
  }
}

export function newSelectorsPlugin(
  persist?: PersistSelectors,
  registry: SelectorRegistry = selectors,
): MeetPlugin {
  console.log("loading selectors plugin");
  return new SelectorsPlugin(registry, persist);
}
