/**
 * The per-feed border palette (#78/#79): a **closed set of 10 tokens** stored on
 * a feed as an identity marker, and the geometry of the border they paint. This
 * module is the **single source of truth** for the token→hex mapping — settings
 * validation ({@link isPaletteToken}), the render resolver
 * ({@link resolvePaletteColor}), and the border geometry all read from here, so
 * the 10 colors can be re-tuned in one place without migrating anyone's stored
 * token (decision #3 on the map). The Property Inspector's swatches (#81) mirror
 * these hexes in static HTML — keep the two in sync by hand.
 *
 * Colors are **vivid, not pastel** (map decision #6): pastel hurt readability at
 * key size; hue separation plus the thin edge-frame geometry keeps a border from
 * reading as its own alarm, even over the red late-flash and teal in-call fields.
 *
 * Pure data + guards, no Stream Deck imports, so it stays vitest-testable and
 * importable from both the UI-agnostic settings layer and the renderer.
 */

/** The 10 border tokens → their vivid hex, chosen & confirmed in #79. */
export const PALETTE = {
  rose: "#ff5c8a",
  orange: "#ff8c42",
  gold: "#ffc61a",
  lime: "#a3e635",
  green: "#3fd160",
  teal: "#14c8b0",
  sky: "#38bdf8",
  blue: "#6086ff",
  violet: "#a855f7",
  magenta: "#e05bd6",
} as const;

/** One of the 10 palette token names. */
export type PaletteToken = keyof typeof PALETTE;

/** The 10 token names, in canonical order (for the PI swatch row / iteration). */
export const PALETTE_TOKENS = Object.keys(PALETTE) as PaletteToken[];

/** Type-guard: is `v` one of the 10 known tokens? (own-key only — no proto keys). */
export function isPaletteToken(v: unknown): v is PaletteToken {
  return typeof v === "string" && Object.hasOwn(PALETTE, v);
}

/**
 * Resolve a stored token to its border hex. Defensive: an absent, empty, or
 * unknown token ⇒ `undefined` (no border), so a stale/hand-seeded value can
 * never inject an arbitrary color.
 */
export function resolvePaletteColor(token: string | undefined): string | undefined {
  return isPaletteToken(token) ? PALETTE[token] : undefined;
}

/**
 * Border geometry (#79), in **on-key px** (keys are 72×72; {@link renderFaceSvg}
 * authors @2x = 144, so it doubles these at draw time). A thin frame just inside
 * the key edge, hugging the physical button corner.
 */
export const BORDER = {
  /** Frame stroke width (2px reads as identity without crowding the glyph). */
  width: 2,
  /** Inset from the key edge to the outer stroke (0 ⇒ flush to the key edge). */
  inset: 0,
  /** Outer corner radius. */
  radius: 12,
} as const;
