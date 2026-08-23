/**
 * Config-over-the-wire selectors, **for the Meet surface**.
 *
 * Every Meet control the extension drives is matched by an **accessible-name
 * substring** (or, for mic/camera, an aria-label substring on a
 * `[data-is-muted]` element). Google renames these over time, which is the
 * usual cause of "a command builds fine but clicks nothing". Historically the
 * fix meant editing the content script, rebuilding, and reloading the Meet tab
 * — and a tab reload drops the call.
 *
 * So the substrings live here as *data*, not code. The plugin (or the dev
 * bridge) can push a `meet.setSelectors` command carrying a partial
 * {@link MeetSelectorConfig}; the extension merges it into its live registry and
 * every subsequent DOM lookup uses the new value **immediately** — no rebuild,
 * no reload, no dropped call. {@link DEFAULT_MEET_SELECTORS} is the compiled-in
 * fallback so an un-configured extension still works.
 *
 * **Meet-scoped on purpose.** Chat's selectors are a different *kind* of value
 * — a CSS row selector plus locale-sensitive rendered-text tokens — so they get
 * their own type in `chat.ts` rather than more keys here. One flat
 * `Record<key, string>` spanning both surfaces would leave a reader no way to
 * tell which values are CSS and which are matched against rendered text, and it
 * would share one storage key between two writers (ADR 0002).
 */

/** The logical Meet controls whose match strings are configurable. */
export const MeetSelectorKey = {
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
  /** Turn-on-captions button accessible-name substring (present only while off). */
  CaptionsOn: "captionsOn",
  /** Turn-off-captions button accessible-name substring (present only while on). */
  CaptionsOff: "captionsOff",
} as const;
export type MeetSelectorKey = (typeof MeetSelectorKey)[keyof typeof MeetSelectorKey];

/** A full set of match strings, one per {@link MeetSelectorKey}. */
export type MeetSelectorConfig = Record<MeetSelectorKey, string>;

/**
 * The compiled-in defaults — the values verified live against Meet as of
 * 2026-07-26. These are the fallback; a pushed `setSelectors` overrides them.
 */
export const DEFAULT_MEET_SELECTORS: MeetSelectorConfig = {
  mic: "microphone",
  camera: "camera",
  leave: "Leave call",
  participants: "People",
  chat: "Chat with everyone",
  handRaise: "Raise hand",
  handLower: "Lower hand",
  reactionOpener: "Send a reaction",
  captionsOn: "Turn on captions",
  captionsOff: "Turn off captions",
};

const KEYS = new Set<string>(Object.values(MeetSelectorKey));

/**
 * Merge an untrusted partial override onto a base config. Unknown keys, and
 * non-string or empty values, are ignored — so a malformed push can only ever
 * fail to change a selector, never blank one out.
 */
export function mergeMeetSelectors(
  base: MeetSelectorConfig,
  partial: Partial<Record<string, unknown>>,
): MeetSelectorConfig {
  const out: MeetSelectorConfig = { ...base };
  for (const [key, value] of Object.entries(partial)) {
    if (KEYS.has(key) && typeof value === "string" && value !== "") {
      out[key as MeetSelectorKey] = value;
    }
  }
  return out;
}
