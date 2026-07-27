import { describe, expect, it } from "vitest";

import type { KeyFace } from "./face.js";
import { renderFaceSvg } from "./render.js";

const svgOf = (face: KeyFace) => renderFaceSvg(face);

describe("renderFaceSvg (§8)", () => {
  it("always returns a complete svg document", () => {
    for (const face of [
      { kind: "loading" },
      { kind: "unconfigured" },
      { kind: "error" },
      { kind: "free", hint: null },
      { kind: "countdown", title: "x", time: "00:00", overdue: false },
    ] satisfies KeyFace[]) {
      const s = svgOf(face);
      expect(s.startsWith("<svg")).toBe(true);
      expect(s.trimEnd().endsWith("</svg>")).toBe(true);
    }
  });

  it("renders the countdown time and title", () => {
    const s = svgOf({ kind: "countdown", title: "Standup", time: "04:59", overdue: false });
    expect(s).toContain("04:59");
    expect(s).toContain("Standup");
  });

  it("escapes XML-special characters in a title", () => {
    const s = svgOf({ kind: "countdown", title: "A & B <x>", time: "00:10", overdue: false });
    expect(s).toContain("&amp;");
    expect(s).toContain("&lt;");
    expect(s).not.toMatch(/<x>/);
  });

  it("shows the free hint when present", () => {
    expect(svgOf({ kind: "free", hint: "Mon 9:00" })).toContain("Mon 9:00");
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
});
