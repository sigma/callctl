import { describe, expect, it } from "vitest";

import { joinIdentity } from "./engine.js";
import {
  computeFace,
  type Escalation,
  type FaceInput,
  MAX_MS,
  msToNextVisibleChange,
} from "./face.js";
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
  heldKeys: new Set(),
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
      time: "20m",
      escalation: "normal",
      blinkOff: false,
    });
  });

  it("flashes late (within grace) for a freshly-started, never-joined event", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    // 1m past start, within the 5m grace window → still the flashing late state, counting up.
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 27, 8, 59), "Sync")] }));
    expect(face.kind).toBe("countdown");
    if (face.kind === "countdown") {
      expect(face.escalation).toBe("late");
      expect(face.time).toBe("+01:00");
    }
  });

  it("calms to steady overdue (not dropped) once past grace, still counting up (§10)", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    // 15m past start, well past the 5m grace window → overdue: steady red, still surfaced, +15m.
    const late = instance(new Date(2026, 6, 27, 8, 45), "Sync", new Date(2026, 6, 27, 9, 30));
    const face = computeFace(base({ now, list: [late] }));
    expect(face.kind).toBe("countdown");
    if (face.kind === "countdown") {
      expect(face.escalation).toBe("overdue");
      expect(face.time).toBe("+15m");
    }
  });

  it("shows an in-progress countdown to the end (not the late flash) once held (§10)", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    // Started 1m ago, ends in 29m; its occurrence is in the held set.
    const started = instance(new Date(2026, 6, 27, 8, 59), "Sync", new Date(2026, 6, 27, 9, 29));
    const face = computeFace(
      base({ now, list: [started], heldKeys: new Set([joinIdentity(started) as string]) }),
    );
    expect(face).toEqual({ kind: "active", title: "Sync", time: "29m" });
  });

  it("does not treat an unheld event as in-call even if its code matches another (§10)", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    // Held set carries a *different* occurrence (other start) of the same code.
    const surfaced = instance(new Date(2026, 6, 27, 9, 20), "Sync");
    const otherOccurrence = instance(new Date(2026, 6, 27, 8, 0), "Sync");
    const face = computeFace(
      base({
        now,
        list: [surfaced],
        heldKeys: new Set([joinIdentity(otherOccurrence) as string]),
      }),
    );
    expect(face).toMatchObject({ kind: "countdown", time: "20m" });
  });

  it("shows Free + a date/time hint when the next event is beyond the horizon", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    // +24h exactly — at the (strict) 24h horizon, so still beyond → Free + hint.
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 28, 9, 0))] }));
    expect(face).toEqual({ kind: "free", hint: { date: "Jul 28", time: "9:00" } });
  });

  it("counts down across local midnight (event on the next date, still within horizon)", () => {
    const now = new Date(2026, 6, 27, 23, 50);
    // 20 min out but on the *next* local date — the old same-day horizon showed
    // Free here; the duration horizon correctly counts down.
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 28, 0, 10), "Late")] }));
    expect(face).toMatchObject({ kind: "countdown", title: "Late", time: "20m" });
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

  it("flashes late through the 5-min grace window, then calms to overdue (no setting)", () => {
    // Grace is hard-wired to the 5-min seconds window: the flash lasts exactly as
    // long as the `+MM:SS` countdown shows seconds, then stops.
    expect(escalationAt(-(5 * 60_000 - 1_000))).toBe("late"); // 4m59s past → still flashing
    expect(escalationAt(-(5 * 60_000 + 1_000))).toBe("overdue"); // 5m01s past → steady
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

describe("msToNextVisibleChange (contract #2–#4)", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const WINDOW = 5 * MIN;
  const IMMINENT_BLINK_HALF = 600;
  const LATE_FLASH_HALF = 450;

  /** A countdown FaceInput: event starts `msToStart` from `nowMs`, +30m long. */
  const countdown = (msToStart: number, nowMs = 0, over: Partial<FaceInput> = {}): FaceInput =>
    base({
      now: new Date(nowMs),
      list: [instance(new Date(nowMs + msToStart), "Sync", new Date(nowMs + msToStart + 30 * MIN))],
      ...over,
    });

  it("static faces fall through to the MAX_MS backstop", () => {
    expect(msToNextVisibleChange(base({ status: "loading" }))).toBe(MAX_MS);
    expect(msToNextVisibleChange(base({ status: "cold-error" }))).toBe(MAX_MS);
    expect(msToNextVisibleChange(base({ configured: false }))).toBe(MAX_MS);
    expect(msToNextVisibleChange(base({ list: [] }))).toBe(MAX_MS); // plain Free (none)
  });

  it("schedules the next whole-second edge in the MM:SS seconds band", () => {
    // 2 min out → approaching (seconds shown, no blink): next tick is the next second.
    expect(msToNextVisibleChange(countdown(2 * MIN, 12_345))).toBe(1_000);
    // A fractional-second offset lands exactly on the coming second, not 1000 later.
    expect(msToNextVisibleChange(countdown(2 * MIN + 400, 0))).toBe(400);
  });

  it("the minute/hour band is governed by the MAX_MS backstop (coarse by design)", () => {
    // Minute ticks (60 s) and hour ticks exceed the 10 s cap, so the render clock
    // wakes on the backstop and repaints — the minute display is intentionally
    // ≤ MAX_MS coarse (contract #2), never a tight per-minute alarm timer.
    expect(msToNextVisibleChange(countdown(20 * MIN + 30_000, 0))).toBe(MAX_MS); // "20m" band
    expect(msToNextVisibleChange(countdown(2 * HOUR + 30_000, 0))).toBe(MAX_MS); // "2h 00" band
  });

  it("never overshoots the seconds↔minute boundary (lands on ±window, not past)", () => {
    // 5m6s out → "5m"; the only change in this band is the crossing back into
    // seconds at |t| = 5 min. Scheduled *on* the window (6 s), never past it.
    expect(msToNextVisibleChange(countdown(WINDOW + 6_000, 0))).toBe(6_000);
  });

  it("never overshoots the minute↔hour boundary (lands on ±hour, not past)", () => {
    // 1h0m3s out → "1h 00"; the coming change is the crossing to the minute band
    // at |t| = 1 h. Scheduled on the hour (3 s), not the far interior minute tick.
    expect(msToNextVisibleChange(countdown(HOUR + 3_000, 0))).toBe(3_000);
  });

  it("drives imminent repaints off the blink edge, landing exactly on a phase flip", () => {
    const HALF = IMMINENT_BLINK_HALF;
    for (const nowMs of [0, 137, 599, 600, 601, 1_000, 4_242]) {
      // 20 s to start → imminent, seconds regime; the min term is the blink edge.
      const delta = msToNextVisibleChange(countdown(20_000, nowMs));
      const blinkEdge = HALF - (nowMs % HALF === 0 ? 0 : nowMs % HALF); // == nextBlinkEdge
      expect(delta).toBeLessThanOrEqual(blinkEdge); // never later than the blink edge
      // Landing on the blink edge flips the phase floor(t/HALF)%2 — never between it.
      if (delta === blinkEdge) {
        expect(Math.floor((nowMs + delta) / HALF) % 2).not.toBe(Math.floor(nowMs / HALF) % 2);
      }
    }
  });

  it("drives late repaints off the 450 ms flash edge", () => {
    const HALF = LATE_FLASH_HALF;
    for (const nowMs of [0, 200, 449, 450, 901]) {
      // 5 s past start, within the 5m grace window → late (flashing): the flash edge bounds the wait.
      const delta = msToNextVisibleChange(countdown(-5_000, nowMs));
      const blinkEdge = HALF - (nowMs % HALF === 0 ? 0 : nowMs % HALF);
      expect(delta).toBeLessThanOrEqual(blinkEdge);
    }
  });

  it("overdue is steady: governed by the backstop, never a sub-second blink", () => {
    // 15 min past start, well past the 5m grace window → overdue (steady red, +15m count-up). No
    // flash, so no sub-HALF edge; the minute tick is capped to the backstop.
    const delta = msToNextVisibleChange(countdown(-15 * MIN, 0));
    expect(delta).toBe(MAX_MS);
    expect(delta).toBeGreaterThan(LATE_FLASH_HALF); // definitely not a flash edge
  });

  it("held (in-call) schedules the count-down-to-end second edge, no blink", () => {
    // Joined, started 1 min ago, ends in 90 s → active "01:30" ticking to end.
    const start = new Date(-60_000);
    const held = instance(start, "Sync", new Date(90_000));
    const input = base({
      now: new Date(0),
      list: [held],
      heldKeys: new Set([joinIdentity(held) as string]),
    });
    expect(computeFace(input).kind).toBe("active");
    expect(msToNextVisibleChange(input)).toBe(1_000); // next second toward the end
  });

  it("held near its end schedules the DTEND boundary (meeting advance)", () => {
    // Ends in 300 ms: the end boundary and the second tick coincide at 300 ms.
    const held = instance(new Date(-60_000), "Sync", new Date(300));
    const input = base({
      now: new Date(0),
      list: [held],
      heldKeys: new Set([joinIdentity(held) as string]),
    });
    expect(msToNextVisibleChange(input)).toBe(300);
  });

  it("beyond-horizon Free schedules the beyond→within crossing (when inside MAX_MS)", () => {
    // Event 24h + 5s out with a 24h horizon → Free; enters the horizon in 5 s.
    const input = base({
      now: new Date(0),
      list: [instance(new Date(24 * HOUR + 5_000), "Later")],
      horizonMs: 24 * HOUR,
    });
    expect(computeFace(input).kind).toBe("free");
    expect(msToNextVisibleChange(input)).toBe(5_000);
  });

  it("a far beyond→within crossing is capped by the MAX_MS backstop", () => {
    // Crossing is 2h out — far past MAX_MS, so the backstop caps the wait.
    const input = base({
      now: new Date(0),
      list: [instance(new Date(26 * HOUR), "Later")],
      horizonMs: 24 * HOUR,
    });
    expect(msToNextVisibleChange(input)).toBe(MAX_MS);
  });

  it("an earlier meeting's DTEND re-indexes an offset-1 key before its own countdown ticks", () => {
    // offset 0 ends in 400 ms; the offset-1 key's face changes then (view re-indexes),
    // sooner than its own far-off minute tick.
    const now = new Date(0);
    const list = [
      instance(new Date(-60_000), "Running", new Date(400)),
      instance(new Date(20 * MIN + 30_000), "Next"),
    ];
    expect(msToNextVisibleChange(base({ now, list, offset: 1 }))).toBe(400);
  });
});
