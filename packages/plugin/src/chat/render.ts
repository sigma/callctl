/**
 * Draw the Chat unread key as an SVG string for `KeyAction.setImage`, mirroring
 * `calendar/render.ts` — same 144×144 @2x canvas, same field colour, same font.
 * Pure string→string, so it is vitest-testable by asserting on the markup.
 */

/** Stream Deck keys render at 72×72; we author at 144 for @2x crispness. */
const SIZE = 144;

const COLOR = {
  /** The normal field, shared with the next-meeting key. */
  bg: "#1c2128",
  /** The no-client field: a visibly deeper, deader slate. */
  bgAbsent: "#15181c",
  /** Connected, quiet **and** unread. Grey means exactly one thing: no client. */
  glyph: "#58a6ff",
  glyphAbsent: "#484f58",
  badge: "#f85149",
  badgeText: "#ffffff",
  label: "#8b949e",
  labelAbsent: "#484f58",
} as const;

const escapeXml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );

/**
 * What the key is being asked to show.
 *
 * Three states, and the colour assignment is load-bearing rather than
 * decorative:
 *
 * | State | Field | Glyph | Badge |
 * |---|---|---|---|
 * | no client | darker | grey, dimmed | none |
 * | connected, nothing unread | normal | **blue** | none |
 * | unread | normal | **blue** | red, with the count |
 *
 * **Quiet is the same blue as unread**, so grey means exactly one thing — *no
 * client*. An earlier prototype dimmed quiet to grey and absent to a slightly
 * deeper grey, which left the "never show a stale count" rule resting on a
 * difference invisible at 72 px.
 *
 * The trade to know: quiet and unread now differ *only* by the badge, where
 * dimmed-grey gave two cues. That makes the badge load-bearing — it reads at one
 * and two digits, and would not at three.
 */
export interface ChatKeyFace {
  /** Is a Chat client attached for this key's binding? */
  connected: boolean;
  /** Unread **and notifying** conversations. Never a message count. */
  count: number;
  /**
   * The label to show, already chosen but **not** yet shortened — pass the full
   * domain and this module strips the TLD (see {@link shortenLabel}).
   */
  label: string;
}

/**
 * Shorten a label for the key: the first dot-label only.
 *
 * `arbora.partners` → `arbora`; `gmail.com` → `gmail`; `acme.co.uk` → `acme`,
 * so a two-part public suffix reduces correctly too.
 *
 * ⚠️ **The wire deliberately carries a value the key never displays verbatim.**
 * The full domain travels so the raw fact stays available — a Property Inspector
 * dropdown has to tell `acme.com` from `acme.dev` — and presentation lives here,
 * next to the renderer. This is legibility, not preference: at 72 px
 * `arbora.partners` is cramped to unreadable while `arbora` is comfortable.
 *
 * A label with no dot (an account-index or id-stub fallback) is left alone.
 */
export function shortenLabel(label: string): string {
  const trimmed = label.trim();
  const dot = trimmed.indexOf(".");
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/** One centred line of text. */
function text(
  content: string,
  y: number,
  size: number,
  fill: string,
  weight: "normal" | "bold" = "normal",
  x = SIZE / 2,
): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(content)}</text>`;
}

/** The speech-bubble subject: a rounded body with a tail at the lower left. */
function bubble(fill: string): string {
  return (
    `<path d="M30 34 h84 a14 14 0 0 1 14 14 v40 a14 14 0 0 1 -14 14 h-46 l-24 20 v-20 h-14 ` +
    `a14 14 0 0 1 -14 -14 v-40 a14 14 0 0 1 14 -14 z" fill="${fill}"/>`
  );
}

/** The count badge, riding the top-right corner. */
function badge(count: number): string {
  const cx = 112;
  const cy = 34;
  const label = String(count);
  // One digit sits in a circle; two widen it into a pill rather than shrinking
  // the digits, which is what keeps 2 digits legible at key size.
  const wide = label.length > 1;
  const rx = wide ? 30 : 24;
  const shape = `<rect x="${cx - rx}" y="${cy - 24}" width="${rx * 2}" height="48" rx="24" fill="${COLOR.badge}"/>`;
  return `${shape}${text(label, cy + 12, 34, COLOR.badgeText, "bold", cx)}`;
}

/** The label strip along the bottom. Always shown. */
function labelStrip(label: string, absent: boolean): string {
  const shortened = shortenLabel(label);
  const clipped = shortened.length > 10 ? `${shortened.slice(0, 9)}…` : shortened;
  return text(clipped, 136, 20, absent ? COLOR.labelAbsent : COLOR.label);
}

/** A full 144×144 @2x document. */
function svg(body: string, bg: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>${body}</svg>`;
}

/** Render a face. Always returns a complete document, ready for `setImage`. */
export function renderChatKeySvg(face: ChatKeyFace): string {
  if (!face.connected) {
    // No client: grey glyph on the deeper field, and **no badge at all** — a
    // count with nothing behind it is exactly the stale number this forbids.
    return svg(`${bubble(COLOR.glyphAbsent)}${labelStrip(face.label, true)}`, COLOR.bgAbsent);
  }
  const body =
    face.count > 0
      ? `${bubble(COLOR.glyph)}${badge(face.count)}${labelStrip(face.label, false)}`
      : `${bubble(COLOR.glyph)}${labelStrip(face.label, false)}`;
  return svg(body, COLOR.bg);
}
