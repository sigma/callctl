import {
  type ChatSelectorConfig,
  DEFAULT_CHAT_SELECTORS,
  mergeChatSelectors,
} from "@callctl/protocol";

/**
 * The extension's live view of the Chat selectors, seeded from
 * {@link DEFAULT_CHAT_SELECTORS} and mutated in place by a `chat.setSelectors`
 * push. Every observation reads the current config fresh, so an override takes
 * effect on the very next scan — no rebuild, no reload.
 */
export class ChatSelectorRegistry {
  #config: ChatSelectorConfig;

  constructor(initial: Partial<Record<string, unknown>> = {}) {
    this.#config = mergeChatSelectors(DEFAULT_CHAT_SELECTORS, initial);
  }

  all(): ChatSelectorConfig {
    return this.#config;
  }

  /** Merge overrides in and return the resulting full config. */
  apply(partial: Partial<Record<string, unknown>>): ChatSelectorConfig {
    this.#config = mergeChatSelectors(this.#config, partial);
    return this.all();
  }
}

/**
 * The module-level registry the Chat plugins read from — the same pattern
 * `meet/selectors.ts` uses, and safe for a reason worth recording: **the two
 * content scripts run in separate JavaScript realms**. There is no shared
 * process, so a per-surface module singleton cannot collide with the other
 * surface's. Tests pass a fresh registry to isolate.
 */
export const chatSelectors = new ChatSelectorRegistry();
