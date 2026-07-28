import { describe, expect, it } from "vitest";

import type { KeyFace } from "./face.js";
import { renderFaceSvg } from "./render.js";

const svgOf = (face: KeyFace) => renderFaceSvg(face);

/** A countdown face with escalation/blink defaults, overridable per test. */
const countdown = (over: Partial<Extract<KeyFace, { kind: "countdown" }>> = {}): KeyFace => ({
  kind: "countdown",
  title: "Standup",
  time: "04:59",
  escalation: "normal",
  blinkOff: false,
  ...over,
});

describe("renderFaceSvg (§8)", () => {
  it("always returns a complete svg document", () => {
    for (const face of [
      { kind: "loading" },
      { kind: "unconfigured" },
      { kind: "error" },
      { kind: "free", hint: null },
      countdown({ time: "00:00" }),
      countdown({ escalation: "late", blinkOff: true, time: "+00:03" }),
    ] satisfies KeyFace[]) {
      const s = svgOf(face);
      expect(s.startsWith("<svg")).toBe(true);
      expect(s.trimEnd().endsWith("</svg>")).toBe(true);
    }
  });

  it("renders the countdown time and title", () => {
    const s = svgOf(countdown({ time: "04:59" }));
    expect(s).toContain("04:59");
    expect(s).toContain("Standup");
  });

  it("escapes XML-special characters in a title", () => {
    const s = svgOf(countdown({ title: "A & B <x>", time: "00:10" }));
    expect(s).toContain("&amp;");
    expect(s).toContain("&lt;");
    expect(s).not.toMatch(/<x>/);
  });

  it("shows the free hint as a 'til <date>' / <time> signpost when present", () => {
    const s = svgOf({ kind: "free", hint: { date: "Aug 11", time: "17:00" } });
    expect(s).toContain("til Aug 11");
    expect(s).toContain("17:00");
    expect(s).toContain("Free");
    expect(svgOf({ kind: "free", hint: null })).toContain("Free");
  });

  it("gives Free, setup and error visibly distinct colours (§8)", () => {
    const colorOf = (s: string) => [...s.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    const free = colorOf(svgOf({ kind: "free", hint: null }));
    const setup = colorOf(svgOf({ kind: "unconfigured" }));
    const error = colorOf(svgOf({ kind: "error" }));
    // Each face carries a foreground hue not shared by the others.
    const fg = (cs: string[]) => cs.filter((c) => c !== "#1c2128");
    expect(fg(free)).not.toEqual(fg(setup));
    expect(fg(setup)).not.toEqual(fg(error));
    expect(fg(free)).not.toEqual(fg(error));
  });

  it("escalates the countdown hue per §8 threshold", () => {
    const timeFill = (s: string) => s.match(/font-size="40"[^>]*fill="(#[0-9a-f]{6})"/)?.[1];
    const normal = timeFill(svgOf(countdown({ escalation: "normal" })));
    const approaching = timeFill(svgOf(countdown({ escalation: "approaching" })));
    const imminent = timeFill(svgOf(countdown({ escalation: "imminent" })));
    // normal is neutral; approaching and imminent are distinct warmer hues.
    expect(new Set([normal, approaching, imminent]).size).toBe(3);
  });

  it("gently dims the imminent glyph on the blink off-half", () => {
    const on = svgOf(countdown({ escalation: "imminent", blinkOff: false }));
    const off = svgOf(countdown({ escalation: "imminent", blinkOff: true }));
    expect(on).not.toContain("opacity=");
    expect(off).toContain("opacity=");
  });

  it("inverts to a solid red field for the late hard-flash off-half", () => {
    const on = svgOf(countdown({ escalation: "late", blinkOff: false, time: "+00:05" }));
    const off = svgOf(countdown({ escalation: "late", blinkOff: true, time: "+00:05" }));
    // On-phase keeps the dark background; off-phase floods the field with red.
    expect(on).toMatch(/<rect[^>]*fill="#1c2128"/);
    expect(off).toMatch(/<rect[^>]*fill="#ff5c50"/);
    // The overdue time is still legible either way.
    expect(off).toContain("+00:05");
  });
});
