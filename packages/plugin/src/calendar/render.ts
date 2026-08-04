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
import { BORDER } from "./palette.js";

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
  /** In-call (§10 joined): a calm teal field, distinct from every alarm hue. */
  active: "#39c5cf",
  activeBg: "#0b2b30",
} as const;

/** The countdown text colour for each §8 escalation state. */
const ESCALATION_COLOR: Record<Escalation, string> = {
  normal: COLOR.countdown,
  approaching: COLOR.approaching,
  imminent: COLOR.imminent,
  late: COLOR.late,
  // Past grace, never joined: steady red — same hue as the flash, no blink.
  overdue: COLOR.late,
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

/**
 * A full 72×72 @2x document; `bg` overrides the field for late's hard flash (§8).
 * `border` (a per-feed identity frame, #78) draws last so it sits above the body.
 */
function svg(body: string, bg: string = COLOR.bg, border = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>${body}${border}</svg>`;
}

/**
 * The per-feed border frame (#78/#79): a thin stroked rect just inside the key
 * edge, geometry from {@link BORDER} (on-key px, doubled here for @2x). `fill`
 * stays `none` so it never obscures the face or the field beneath it.
 */
function borderRect(color: string): string {
  const w = BORDER.width * 2;
  const inset = BORDER.inset * 2;
  const radius = BORDER.radius * 2;
  // Stroke straddles its path, so inset by half the width to keep it on-canvas.
  const x = inset + w / 2;
  const side = SIZE - 2 * x;
  const rx = Math.max(0, radius - x);
  return `<rect x="${x}" y="${x}" width="${side}" height="${side}" rx="${rx}" fill="none" stroke="${color}" stroke-width="${w}"/>`;
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
 *
 * `borderColor` is the resolved per-feed identity hex (#78), threaded in
 * **orthogonally to {@link KeyFace}** — the border is feed identity, not a face
 * property. It paints on every feed-resolved face (including the red late-flash
 * and teal in-call fields); `unconfigured` has no feed, so it never gets one.
 */
export function renderFaceSvg(face: KeyFace, borderColor?: string): string {
  // Every face but `unconfigured` carries the feed's border, when one is set.
  const border =
    borderColor !== undefined && face.kind !== "unconfigured" ? borderRect(borderColor) : "";
  switch (face.kind) {
    case "countdown": {
      // Late hard flash (§8): on the off half, invert to a solid red field with
      // dark glyphs — an unmissable, attention-grabbing flash.
      if (face.escalation === "late" && face.blinkOff) {
        return svg(
          `${titleStrip(face.title, COLOR.bg)}${text(face.time, 90, 40, COLOR.bg, "bold")}`,
          COLOR.late,
          border,
        );
      }
      // Big MM:SS centred, title a thin top strip (Variant A). Colour by
      // escalation; imminent's gentle blink dims the glyph on the off half.
      const fg = ESCALATION_COLOR[face.escalation];
      const opacity = face.escalation === "imminent" && face.blinkOff ? BLINK_DIM : 1;
      return svg(
        `${titleStrip(face.title)}${text(face.time, 90, 40, fg, "bold", opacity)}`,
        COLOR.bg,
        border,
      );
    }
    case "active":
      // In-call (§10): same big-countdown layout as a live countdown, but a calm
      // teal field + steady glyph — you are here, so no blink, no alarm colour.
      return svg(
        `${titleStrip(face.title)}${text(face.time, 90, 40, COLOR.active, "bold")}`,
        COLOR.activeBg,
        border,
      );
    case "free":
      // No next meeting → a single centred "Free". Otherwise stack the signpost:
      // "Free" over "til <date>" over "<time>", the date/time lines in the title
      // strip colour so "til" reads as the bridge into the next-meeting date (§8).
      return svg(
        face.hint === null
          ? text("Free", 84, 34, COLOR.free, "bold")
          : `${text("Free", 54, 30, COLOR.free, "bold")}${text(`til ${face.hint.date}`, 90, 18, COLOR.title)}${text(face.hint.time, 116, 18, COLOR.title)}`,
        COLOR.bg,
        border,
      );
    case "unconfigured":
      // Setup prompt — visually distinct (blue) from Free (green) and error
      // (red). No feed ⇒ never a border.
      return svg(
        `${text("Set up", 68, 24, COLOR.setup, "bold")}${text("feed", 96, 20, COLOR.setup)}`,
      );
    case "error":
      // Cold-start error — dedicated attention glyph, muted red (§8).
      return svg(
        `${text("!", 74, 52, COLOR.error, "bold")}${text("No data", 108, 18, COLOR.error)}`,
        COLOR.bg,
        border,
      );
    case "loading":
      return svg(text("…", 92, 44, COLOR.title, "bold"), COLOR.bg, border);
  }
}
