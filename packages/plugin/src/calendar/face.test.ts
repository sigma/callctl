import { describe, expect, it } from "vitest";

import { computeFace, type Escalation, type FaceInput } from "./face.js";
import type { MeetingInstance } from "./types.js";

/** A link-bearing instance at a given start; end defaults to +30m. */
function instance(start: Date, title = "Standup", end?: Date): MeetingInstance {
  return {
    start,
    end: end ?? new Date(start.getTime() + 30 * 60 * 1000),
    allDay: false,
    title,
    sourceFeedId: "work",
    candidate: {
      tier: "a",
      provider: "gmeet",
      code: "gmeet:abc-def-ghi",
      joinUrl: "https://meet.google.com/abc-def-ghi",
    },
  };
}

const base = (over: Partial<FaceInput>): FaceInput => ({
  configured: true,
  status: "ok",
  list: [],
  offset: 0,
  now: new Date(2026, 6, 27, 9, 0),
  horizonMs: 24 * 60 * 60 * 1000,
  ...over,
});

describe("computeFace (§8 baseline)", () => {
  it("unconfigured beats every data state", () => {
    expect(computeFace(base({ configured: false, status: "cold-error" }))).toEqual({
      kind: "unconfigured",
    });
  });

  it("cold-start error when a poll failed with no cache", () => {
    expect(computeFace(base({ status: "cold-error" }))).toEqual({ kind: "error" });
  });

  it("loading before the first poll lands", () => {
    expect(computeFace(base({ status: "loading" }))).toEqual({ kind: "loading" });
  });

  it("counts down to a later-today event", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 27, 9, 20), "Sync")] }));
    expect(face).toEqual({
      kind: "countdown",
      title: "Sync",
      time: "20:00",
      escalation: "normal",
      blinkOff: false,
    });
  });

  it("marks an already-started event late with a +MM:SS count-up", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 27, 8, 59), "Sync")] }));
    expect(face.kind).toBe("countdown");
    if (face.kind === "countdown") {
      expect(face.escalation).toBe("late");
      expect(face.time).toBe("+01:00");
    }
  });

  it("shows Free + a day hint when the next event is beyond the horizon", () => {
    const now = new Date(2026, 6, 27, 9, 0); // Mon
    // +24h exactly — at the (strict) 24h horizon, so still beyond → Free + hint.
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 28, 9, 0))] })); // Tue
    expect(face).toEqual({ kind: "free", hint: "Tue 9:00" });
  });

  it("counts down across local midnight (event on the next date, still within horizon)", () => {
    const now = new Date(2026, 6, 27, 23, 50);
    // 20 min out but on the *next* local date — the old same-day horizon showed
    // Free here; the duration horizon correctly counts down.
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 28, 0, 10), "Late")] }));
    expect(face).toMatchObject({ kind: "countdown", title: "Late", time: "20:00" });
  });

  it("shows plain Free when there is no event at this offset", () => {
    expect(computeFace(base({ list: [] }))).toEqual({ kind: "free", hint: null });
  });

  it("selects the event at the key's offset", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    const list = [
      instance(new Date(2026, 6, 27, 9, 5), "First"),
      instance(new Date(2026, 6, 27, 9, 20), "Second"),
    ];
    const face = computeFace(base({ now, list, offset: 1 }));
    expect(face).toMatchObject({ kind: "countdown", title: "Second" });
  });
});

describe("computeFace escalation (§8)", () => {
  /** The escalation state for a countdown whose event starts `msToStart` from now. */
  const escalationAt = (msToStart: number, nowMs = 0): Escalation | undefined => {
    const now = new Date(nowMs);
    const face = computeFace(base({ now, list: [instance(new Date(nowMs + msToStart))] }));
    return face.kind === "countdown" ? face.escalation : undefined;
  };

  it("is normal beyond 5 minutes, approaching at/under 5, imminent at/under 30s", () => {
    expect(escalationAt(6 * 60_000)).toBe("normal");
    expect(escalationAt(5 * 60_000)).toBe("approaching"); // 5 min boundary is approaching
    expect(escalationAt(31_000)).toBe("approaching");
    expect(escalationAt(30_000)).toBe("imminent"); // 30 s boundary is imminent
    expect(escalationAt(1_000)).toBe("imminent");
  });

  it("is late once the event has started (negative time-to-start)", () => {
    expect(escalationAt(-1_000)).toBe("late");
  });

  it("imminent gently blinks off on the off half of the ~1.2s cycle", () => {
    // half-cycle = 600 ms: t=0 → on, t=600 → off.
    const onFace = computeFace(base({ now: new Date(0), list: [instance(new Date(10_000))] }));
    const offFace = computeFace(base({ now: new Date(600), list: [instance(new Date(10_600))] }));
    expect(onFace).toMatchObject({ escalation: "imminent", blinkOff: false });
    expect(offFace).toMatchObject({ escalation: "imminent", blinkOff: true });
  });

  it("late hard-flashes off on the off half of the ~0.9s cycle", () => {
    // half-cycle = 450 ms: t=0 → on, t=450 → off.
    const onFace = computeFace(base({ now: new Date(0), list: [instance(new Date(-5_000))] }));
    const offFace = computeFace(base({ now: new Date(450), list: [instance(new Date(-4_550))] }));
    expect(onFace).toMatchObject({ escalation: "late", blinkOff: false });
    expect(offFace).toMatchObject({ escalation: "late", blinkOff: true });
  });

  it("steady states never blink", () => {
    for (const ms of [6 * 60_000, 2 * 60_000]) {
      const face = computeFace(base({ now: new Date(600), list: [instance(new Date(600 + ms))] }));
      expect(face).toMatchObject({ blinkOff: false });
    }
  });
});
