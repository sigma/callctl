/**
 * Draw a {@link KeyFace} as an SVG string for `KeyAction.setImage` (§8, Variant
 * A — countdown-primary: a big `MM:SS` fills the key, the title is a thin top
 * strip). Pure string→string, so it's vitest-testable by asserting on the
 * markup.
 *
 * This is the **baseline, non-escalating** palette (#58): a single neutral slate
 * for every countdown, green for Free, blue for the setup prompt, muted red for
 * the cold-start error — three visibly distinct non-countdown faces (§8). The
 * per-threshold escalation colours and blink/flash (orange/red, §8 table) layer
 * on in #59; they are deliberately absent here.
 */

import type { KeyFace } from "./face.js";

/** Stream Deck keys render at 72×72; we author at 144 for @2x crispness. */
const SIZE = 144;

/** Baseline palette (#58) — escalation hues (orange/red thresholds) come in #59. */
const COLOR = {
  bg: "#1c2128",
  countdown: "#e6edf3",
  title: "#8b949e",
  free: "#3fb950",
  setup: "#58a6ff",
  error: "#f85149",
} as const;

const escapeXml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );

/** One centred line of text. */
function text(
  content: string,
  y: number,
  size: number,
  fill: string,
  weight: "normal" | "bold" = "normal",
): string {
  return `<text x="72" y="${y}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(content)}</text>`;
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${COLOR.bg}"/>${body}</svg>`;
}

/** A short title trimmed to a strip-friendly length. */
function titleStrip(title: string): string {
  const t = title.trim() || "Meeting";
  const clipped = t.length > 12 ? `${t.slice(0, 11)}…` : t;
  return text(clipped, 26, 16, COLOR.title);
}

/**
 * Render the SVG for a face. Every branch returns a complete `<svg>` document
 * (72×72 @2x) suitable for `setImage`.
 */
export function renderFaceSvg(face: KeyFace): string {
  switch (face.kind) {
    case "countdown":
      // Big MM:SS centred, title a thin top strip (Variant A). Neutral in #58.
      return svg(`${titleStrip(face.title)}${text(face.time, 90, 40, COLOR.countdown, "bold")}`);
    case "free":
      return svg(
        face.hint === null
          ? text("Free", 84, 34, COLOR.free, "bold")
          : `${text("Free", 68, 30, COLOR.free, "bold")}${text(face.hint, 100, 18, COLOR.title)}`,
      );
    case "unconfigured":
      // Setup prompt — visually distinct (blue) from Free (green) and error (red).
      return svg(
        `${text("Set up", 68, 24, COLOR.setup, "bold")}${text("feed", 96, 20, COLOR.setup)}`,
      );
    case "error":
      // Cold-start error — dedicated attention glyph, muted red (§8).
      return svg(
        `${text("!", 74, 52, COLOR.error, "bold")}${text("No data", 108, 18, COLOR.error)}`,
      );
    case "loading":
      return svg(text("…", 92, 44, COLOR.title, "bold"));
  }
}
