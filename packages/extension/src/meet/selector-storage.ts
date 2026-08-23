import type { MeetSelectorConfig } from "@callctl/protocol";

/**
 * Where Meet's selector overrides live in `chrome.storage.local`, and the one
 * migration that got them there.
 *
 * `chrome.storage.local` is a **single store per extension install**, shared by
 * every content script — so the bare `selectors` key the first version used is
 * not "Meet's key", it is *the extension's* key. A Chat content script writing
 * its own selectors would land on top of Meet's and silently blank them (ADR
 * 0002). Scoping the key by surface makes that impossible rather than unlikely,
 * and pairing it with a per-surface config type means a `ChatSelectorConfig`
 * cannot be written here even by mistake.
 *
 * Nothing outside this module names either key.
 */

/** The Meet-scoped key. Mirrors the `meet.*` wire namespace on purpose. */
const MEET_SELECTORS_KEY = "meet.selectors";

/** The install-wide key the pre-split extension wrote. Read once, then dropped. */
const LEGACY_SELECTORS_KEY = "selectors";

/**
 * Read Meet's persisted overrides, migrating a pre-split install on the way.
 *
 * A user who tracked down a renamed aria-label and pushed the fix over the wire
 * has it persisted under the legacy key; losing it here would silently
 * re-break their Meet on the first run after the refactor. So: the Meet-scoped
 * key wins if present, otherwise the legacy value is adopted, rewritten under
 * the new key and the old one removed — the migration runs exactly once.
 *
 * Returns a *partial* config: these are overrides, overlaid on
 * `DEFAULT_MEET_SELECTORS` by the registry, never a full replacement.
 */
export function loadMeetSelectors(
  local: chrome.storage.LocalStorageArea,
): Promise<Partial<MeetSelectorConfig>> {
  return new Promise((resolve) => {
    local.get([MEET_SELECTORS_KEY, LEGACY_SELECTORS_KEY], (items) => {
      const scoped = items[MEET_SELECTORS_KEY] as Partial<MeetSelectorConfig> | undefined;
      if (scoped !== undefined) {
        resolve(scoped);
        return;
      }

      const legacy = items[LEGACY_SELECTORS_KEY] as Partial<MeetSelectorConfig> | undefined;
      if (legacy === undefined) {
        resolve({});
        return;
      }

      local.set({ [MEET_SELECTORS_KEY]: legacy }, () => {
        local.remove(LEGACY_SELECTORS_KEY, () => resolve(legacy));
      });
    });
  });
}

/**
 * Persist the full merged config under the Meet-scoped key. Called by the
 * selectors plugin after a `meet.setSelectors` push, so a field fix survives a
 * tab reload.
 */
export function saveMeetSelectors(
  local: chrome.storage.LocalStorageArea,
  config: MeetSelectorConfig,
): void {
  local.set({ [MEET_SELECTORS_KEY]: config });
}
