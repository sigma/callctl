/**
 * Meet reactions. Port of `meetremote/internal/api.Reaction` +
 * `meetdeck/internal/google_reaction.go`'s slug map.
 *
 * The wire `data` for a `react` command is the human LABEL (e.g. "waving
 * hand"): the extension matches it against the emoji button's `alt` text in the
 * Meet DOM. The SLUG (e.g. "wave") is the stable key used for Stream Deck
 * action ids (`react-wave`) and CLI names.
 */
export const ReactionLabels = {
  wave: "waving hand",
  yes: "thumbs up",
  no: "thumbs down",
  clap: "clapping hands",
  love: "sparkling heart",
  laugh: "face with tears of joy",
  plus: "plus",
  party: "party popper",
  rainbow: "rainbow flag",
  crab: "crab",
  blown: "exploding head",
  "100": "one hundred",
} as const;

export type ReactionSlug = keyof typeof ReactionLabels;

/** All reaction slugs in the canonical order they were declared in Go. */
export const REACTION_SLUGS = Object.keys(ReactionLabels) as ReactionSlug[];

/** Wire `data` (the Meet alt-text label) for a reaction slug. */
export function reactionLabel(slug: ReactionSlug): string {
  return ReactionLabels[slug];
}
