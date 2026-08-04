#!/usr/bin/env bun
/**
 * Regenerate the 9 Stream Deck reaction icons from Google Noto Color Emoji.
 *
 * Run via `just gen-react-icons` (which enters the pinned `icon-gen` devShell so
 * `resvg`, `magick`, and $NOTO_EMOJI_SVG are all present). Do not port the
 * slug/glyph list here — it is read from `@callctl/protocol` so the icons can
 * never drift from the wire reactions.
 *
 * Pipeline (decided in issues #83–#86):
 *   Noto svg/emoji_u<cp>.svg  (true vector)
 *     └ resvg  -w 512         → oversampled PNG (crisp, no upscaling)
 *     └ magick -trim          → strip to the glyph's ink
 *              -resize N       → longest side = N (aspect preserved)
 *              -extent CxC     → center on a transparent CxC tile
 *
 * Locked geometry: glyph longest side = 76% of the tile, geometric-center.
 *   @2x → 144×144 tile, 110px glyph.   1x → 72×72 tile, 55px glyph.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REACTION_SLUGS, ReactionLabels } from "../../protocol/src/reactions.ts";

/** One output size: the tile edge and the glyph's longest-side target. */
const SIZES = [
  { canvas: 144, glyph: 110, suffix: "@2x" },
  { canvas: 72, glyph: 55, suffix: "" },
] as const;

const svgDir = process.env.NOTO_EMOJI_SVG;
if (!svgDir) {
  console.error(
    "NOTO_EMOJI_SVG is unset — run this via `just gen-react-icons` (icon-gen devShell).",
  );
  process.exit(1);
}

const outDir = join(import.meta.dir, "..", "dev.yrh.callctl.sdPlugin", "imgs", "actions");

/** Unicode scalar values of a glyph, hex, joined by `_` (handles ZWJ sequences). */
const codepoints = (glyph: string): string =>
  [...glyph].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0")).join("_");

const tmp = mkdtempSync(join(tmpdir(), "react-icons-"));
try {
  for (const slug of REACTION_SLUGS) {
    const glyph = ReactionLabels[slug];
    const src = join(svgDir, `emoji_u${codepoints(glyph)}.svg`);
    if (!existsSync(src)) {
      console.error(`missing Noto source for ${slug} (${glyph}): ${src}`);
      process.exit(1);
    }

    for (const { canvas, glyph: side, suffix } of SIZES) {
      const big = join(tmp, "big.png");
      const out = join(outDir, `react_${slug}${suffix}.png`);
      // Oversample well above the target so the trim + downscale stays crisp.
      execFileSync("resvg", ["-w", "512", "-h", "512", src, big]);
      execFileSync("magick", [
        big,
        "-trim",
        "+repage",
        "-resize",
        `${side}x${side}`,
        "-background",
        "none",
        "-gravity",
        "center",
        "-extent",
        `${canvas}x${canvas}`,
        out,
      ]);
    }
    console.log(`✓ react_${slug}  (${glyph}  U+${codepoints(glyph).toUpperCase()})`);
  }
  console.log(`\nRegenerated ${REACTION_SLUGS.length * 2} files in ${outDir}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
