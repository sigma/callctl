import type { ChatSelectorConfig } from "@callctl/protocol";

/**
 * Where Chat's selector overrides live in `chrome.storage.local`.
 *
 * Scoped by surface, like Meet's: the store is one per extension install and
 * shared by every content script, so an unscoped key is not "Chat's key", it is
 * *the extension's* (ADR 0002). Pairing the scoped key with a per-surface config
 * type means a `MeetSelectorConfig` cannot land here even by mistake.
 *
 * Nothing outside this module names the key. There is no migration: Chat has no
 * pre-split installs to migrate from.
 */
const CHAT_SELECTORS_KEY = "chat.selectors";

/** Read Chat's persisted overrides. Partial: these overlay the defaults. */
export function loadChatSelectors(
  local: chrome.storage.LocalStorageArea,
): Promise<Partial<Record<string, unknown>>> {
  return new Promise((resolve) => {
    local.get([CHAT_SELECTORS_KEY], (items) => {
      const stored = items[CHAT_SELECTORS_KEY] as Partial<Record<string, unknown>> | undefined;
      resolve(stored ?? {});
    });
  });
}

/** Persist the merged config, so a field fix survives a reload. */
export function saveChatSelectors(
  local: chrome.storage.LocalStorageArea,
  config: ChatSelectorConfig,
): void {
  local.set({ [CHAT_SELECTORS_KEY]: config });
}
