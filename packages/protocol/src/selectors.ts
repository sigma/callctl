/**
 * Config-over-the-wire selectors.
 *
 * Every Meet control the extension drives is matched by an **accessible-name
 * substring** (or, for mic/camera, an aria-label substring on a
 * `[data-is-muted]` element). Google renames these over time, which is the
 * usual cause of "a command builds fine but clicks nothing". Historically the
 * fix meant editing the content script, rebuilding, and reloading the Meet tab
 * — and a tab reload drops the call.
 *
 * So the substrings live here as *data*, not code. The plugin (or the dev
 * bridge) can push a `setSelectors` command carrying a partial
 * {@link SelectorConfig}; the extension merges it into its live registry and
 * every subsequent DOM lookup uses the new value **immediately** — no rebuild,
 * no reload, no dropped call. {@link DEFAULT_SELECTORS} is the compiled-in
 * fallback so an un-configured extension still works.
 */

/** The logical Meet controls whose match strings are configurable. */
export const SelectorKey = {
  /** aria-label substring on the mic `[data-is-muted]` button. */
  Mic: "mic",
  /** aria-label substring on the camera `[data-is-muted]` button. */
  Camera: "camera",
  /** Leave-call button accessible-name substring. */
  Leave: "leave",
  /** Participants/People panel toggle accessible-name substring. */
  Participants: "participants",
  /** Chat panel toggle accessible-name substring. */
  Chat: "chat",
  /** Raise-hand button accessible-name substring. */
  HandRaise: "handRaise",
  /** Lower-hand button accessible-name substring (present only while raised). */
  HandLower: "handLower",
  /** "Send a reaction" opener accessible-name substring. */
  ReactionOpener: "reactionOpener",
} as const;
export type SelectorKey = (typeof SelectorKey)[keyof typeof SelectorKey];

/** A full set of match strings, one per {@link SelectorKey}. */
export type SelectorConfig = Record<SelectorKey, string>;

/**
 * The compiled-in defaults — the values verified live against Meet as of
 * 2026-07-26. These are the fallback; a pushed `setSelectors` overrides them.
 */
export const DEFAULT_SELECTORS: SelectorConfig = {
  mic: "microphone",
  camera: "camera",
  leave: "Leave call",
  participants: "People",
  chat: "Chat with everyone",
  handRaise: "Raise hand",
  handLower: "Lower hand",
  reactionOpener: "Send a reaction",
};

const KEYS = new Set<string>(Object.values(SelectorKey));

/**
 * Merge an untrusted partial override onto a base config. Unknown keys, and
 * non-string or empty values, are ignored — so a malformed push can only ever
 * fail to change a selector, never blank one out.
 */
export function mergeSelectors(
  base: SelectorConfig,
  partial: Partial<Record<string, unknown>>,
): SelectorConfig {
  const out: SelectorConfig = { ...base };
  for (const [key, value] of Object.entries(partial)) {
    if (KEYS.has(key) && typeof value === "string" && value !== "") {
      out[key as SelectorKey] = value;
    }
  }
  return out;
}
