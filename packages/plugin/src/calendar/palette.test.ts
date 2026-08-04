import { describe, expect, it } from "vitest";

import { BORDER, isPaletteToken, PALETTE, PALETTE_TOKENS, resolvePaletteColor } from "./palette.js";

describe("border palette (#78/#79)", () => {
  it("is a closed set of exactly 10 tokens", () => {
    expect(PALETTE_TOKENS).toHaveLength(10);
    expect(new Set(PALETTE_TOKENS).size).toBe(10);
  });

  it("maps every token to a distinct 6-digit hex", () => {
    const hexes = PALETTE_TOKENS.map((t) => PALETTE[t]);
    for (const hex of hexes) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  it("resolves a known token to its hex", () => {
    expect(resolvePaletteColor("teal")).toBe(PALETTE.teal);
    expect(resolvePaletteColor("rose")).toBe(PALETTE.rose);
  });

  it("resolves an absent, empty, or unknown token to undefined (no border)", () => {
    for (const bad of [undefined, "", "puce", "TEAL", "constructor", "#ff5c8a"]) {
      expect(resolvePaletteColor(bad as string | undefined)).toBeUndefined();
    }
  });

  it("guards tokens by own-key only, never inherited proto keys", () => {
    expect(isPaletteToken("gold")).toBe(true);
    expect(isPaletteToken("toString")).toBe(false);
    expect(isPaletteToken(42)).toBe(false);
  });

  it("exposes on-key border geometry (#79)", () => {
    expect(BORDER).toEqual({ width: 2, inset: 0, radius: 12 });
  });
});
