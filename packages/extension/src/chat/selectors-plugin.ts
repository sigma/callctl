import { ChatCommand, ChatEvent, type ChatSelectorConfig, message } from "@callctl/protocol";
import type { SurfacePlugin } from "../core/plugin.js";
import type { Transport } from "../core/transport/transport.js";
import { type ChatSelectorRegistry, chatSelectors } from "./selectors.js";

/**
 * Config-over-the-wire selectors for Chat — the same first-class drift fix Meet
 * has, under Chat's own ops and its own storage key (ADR 0002).
 *
 * It matters more here than it looks: Chat's tokens are locale-sensitive
 * English strings, so a non-English session silently reports zero unread. A
 * pushed override is the fix, and it applies on the **next observation** with no
 * rebuild and no reload.
 *
 * Wire protocol:
 *   ← { event: "chat.getSelectors" }                      → push current config
 *   ← { event: "chat.setSelectors", data: <partial JSON> } → merge, persist, push
 *   → { event: "chat.selectors", data: <full config JSON> }
 */
export type PersistChatSelectors = (config: ChatSelectorConfig) => void;

class ChatSelectorsPlugin implements SurfacePlugin {
  readonly #registry: ChatSelectorRegistry;
  readonly #persist: PersistChatSelectors;

  constructor(registry: ChatSelectorRegistry, persist: PersistChatSelectors) {
    this.#registry = registry;
    this.#persist = persist;
  }

  ID(): string {
    return "chat-selectors";
  }

  // No hooks. In particular it must NOT set `t.onConnect`, a single settable
  // field the roster plugin owns — a second setter would silence the on-connect
  // roster push.
  installHooks(_t: Transport): void {}

  installHandlers(t: Transport): void {
    const push = () => t.send(message(ChatEvent.Selectors, JSON.stringify(this.#registry.all())));

    t.handle(ChatCommand.GetSelectors, () => push());

    t.handle(ChatCommand.SetSelectors, (msg) => {
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

export function newChatSelectorsPlugin(
  persist: PersistChatSelectors = () => {},
  registry: ChatSelectorRegistry = chatSelectors,
): SurfacePlugin {
  console.log("loading chat selectors plugin");
  return new ChatSelectorsPlugin(registry, persist);
}
