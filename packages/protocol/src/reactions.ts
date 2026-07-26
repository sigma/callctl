/**
 * Meet reactions.
 *
 * Meet reworked its reaction UI: the old `.emojiPng[alt="waving hand"]` grid is
 * gone. Reactions are now a fixed bar of 9 emoji buttons, each exposing the
 * **emoji glyph itself as its `aria-label`** (e.g. `aria-label="👍"`), opened
 * from a `"Send a reaction"` button. So the wire `data` for a `react` command is
 * now the glyph, which the extension matches against `button[aria-label="<glyph>"]`.
 *
 * The set is realigned to exactly what Meet offers (was 12 human-labelled
 * reactions; wave/plus/rainbow/crab/blown/100 no longer exist). The SLUG (e.g.
 * `yes`) is still the stable key for Stream Deck action ids (`react-yes`) and
 * CLI names; the glyph is the wire value. Order matches Meet's on-screen bar.
 */
export const ReactionLabels = {
  love: "💖",
  yes: "👍",
  party: "🎉",
  clap: "👏",
  laugh: "😂",
  surprise: "😮",
  cry: "😢",
  think: "🤔",
  no: "👎",
} as const;

export type ReactionSlug = keyof typeof ReactionLabels;

/** All reaction slugs in Meet's on-screen bar order. */
export const REACTION_SLUGS = Object.keys(ReactionLabels) as ReactionSlug[];

/** Wire `data` for a reaction slug — the emoji glyph = the Meet button's `aria-label`. */
export function reactionLabel(slug: ReactionSlug): string {
  return ReactionLabels[slug];
}
