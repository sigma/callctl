/**
 * Draw a {@link KeyFace} as an SVG string for `KeyAction.setImage` (§8, Variant
 * A — countdown-primary: a big `MM:SS` fills the key, the title is a thin top
 * strip). Pure string→string, so it's vitest-testable by asserting on the
 * markup.
 *
 * The countdown now carries the full §8 escalation palette (#59): steady slate
 * (normal) → steady orange (approaching) → red with a gentle blink (imminent) →
 * a hard red flash counting up (late). Green for Free, blue for the setup
 * prompt, muted red for the cold-start error remain the three distinct
 * non-countdown faces (§8).
 */

import type { Escalation, KeyFace } from "./face.js";

/** Stream Deck keys render at 72×72; we author at 144 for @2x crispness. */
const SIZE = 144;

const COLOR = {
  bg: "#1c2128",
  countdown: "#e6edf3",
  title: "#8b949e",
  free: "#3fb950",
  setup: "#58a6ff",
  error: "#f85149",
  /** §8 escalation hues, keyed by threshold. */
  approaching: "#f0883e",
  imminent: "#f85149",
  late: "#ff5c50",
} as const;

/** The countdown text colour for each §8 escalation state. */
const ESCALATION_COLOR: Record<Escalation, string> = {
  normal: COLOR.countdown,
  approaching: COLOR.approaching,
  imminent: COLOR.imminent,
  late: COLOR.late,
};

/** Dimmed opacity for imminent's gentle blink off-phase (§8). */
const BLINK_DIM = 0.3;

const escapeXml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );

/** One centred line of text. `opacity < 1` drives the imminent gentle blink (§8). */
function text(
  content: string,
  y: number,
  size: number,
  fill: string,
  weight: "normal" | "bold" = "normal",
  opacity = 1,
): string {
  const op = opacity < 1 ? ` opacity="${opacity}"` : "";
  return `<text x="72" y="${y}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}"${op}>${escapeXml(content)}</text>`;
}

/** A full 72×72 @2x document; `bg` overrides the field for late's hard flash (§8). */
function svg(body: string, bg: string = COLOR.bg): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>${body}</svg>`;
}

/** A short title trimmed to a strip-friendly length. */
function titleStrip(title: string, fill: string = COLOR.title): string {
  const t = title.trim() || "Meeting";
  const clipped = t.length > 12 ? `${t.slice(0, 11)}…` : t;
  return text(clipped, 26, 16, fill);
}

/**
 * Render the SVG for a face. Every branch returns a complete `<svg>` document
 * (72×72 @2x) suitable for `setImage`.
 */
export function renderFaceSvg(face: KeyFace): string {
  switch (face.kind) {
    case "countdown": {
      // Late hard flash (§8): on the off half, invert to a solid red field with
      // dark glyphs — an unmissable, attention-grabbing flash.
      if (face.escalation === "late" && face.blinkOff) {
        return svg(
          `${titleStrip(face.title, COLOR.bg)}${text(face.time, 90, 40, COLOR.bg, "bold")}`,
          COLOR.late,
        );
      }
      // Big MM:SS centred, title a thin top strip (Variant A). Colour by
      // escalation; imminent's gentle blink dims the glyph on the off half.
      const fg = ESCALATION_COLOR[face.escalation];
      const opacity = face.escalation === "imminent" && face.blinkOff ? BLINK_DIM : 1;
      return svg(`${titleStrip(face.title)}${text(face.time, 90, 40, fg, "bold", opacity)}`);
    }
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
