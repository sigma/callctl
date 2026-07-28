import { describe, expect, it } from "vitest";

import { formatCountdown, formatMeetingHint, SECONDS_WINDOW_MS } from "./format.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("SECONDS_WINDOW_MS (contract #1)", () => {
  it("is the shared ±5 min seconds boundary (imported by the render clock)", () => {
    expect(SECONDS_WINDOW_MS).toBe(5 * MIN);
  });
});

describe("formatCountdown (§8) — seconds band (|t| ≤ 5 min)", () => {
  it("renders MM:SS remaining, up to and including the 5 min boundary", () => {
    expect(formatCountdown(5 * MIN)).toBe("05:00");
    expect(formatCountdown(90 * SEC)).toBe("01:30");
    expect(formatCountdown(9 * SEC)).toBe("00:09");
  });

  it("rounds remaining time up so it hits 00:00 exactly at start", () => {
    expect(formatCountdown(1)).toBe("00:01");
    expect(formatCountdown(999)).toBe("00:01");
    expect(formatCountdown(0)).toBe("00:00");
  });

  it("renders +MM:SS elapsed, counting up from +00:00, to the 5 min boundary", () => {
    expect(formatCountdown(-1)).toBe("+00:00");
    expect(formatCountdown(-90 * SEC)).toBe("+01:30");
    expect(formatCountdown(-5 * MIN)).toBe("+05:00");
  });
});

describe("formatCountdown (§8) — minute band (5 min < |t| < 1 h)", () => {
  it("renders a bare minute count with an `m` suffix, never seconds", () => {
    expect(formatCountdown(42 * MIN)).toBe("42m");
    expect(formatCountdown(6 * MIN)).toBe("6m");
    expect(formatCountdown(30 * MIN)).not.toContain(":");
  });

  it("mirrors the elapsed side with a `+` prefix", () => {
    expect(formatCountdown(-42 * MIN)).toBe("+42m");
    expect(formatCountdown(-6 * MIN)).toBe("+6m");
  });

  it("floors the minute count so no minute value is skipped", () => {
    // Floor, not ceil: a partial minute reads as its lower whole minute, and
    // the top of the band never rounds up into a bogus `60m`.
    expect(formatCountdown(6 * MIN + 59 * SEC)).toBe("6m");
    expect(formatCountdown(59 * MIN + 59 * SEC)).toBe("59m");
    expect(formatCountdown(HOUR - 1)).toBe("59m");
  });
});

describe("formatCountdown (§8) — hour band (|t| ≥ 1 h)", () => {
  it("renders Hh MM at and beyond one hour", () => {
    expect(formatCountdown(HOUR)).toBe("1h 00");
    expect(formatCountdown(2 * HOUR + 5 * MIN)).toBe("2h 05");
  });

  it("mirrors the elapsed side with a `+` prefix", () => {
    expect(formatCountdown(-1 * HOUR - 5 * MIN)).toBe("+1h 05");
  });
});

describe("formatCountdown (§8) — band boundary transitions", () => {
  it("crosses seconds↔minute at exactly 5 min (both signs)", () => {
    expect(formatCountdown(5 * MIN)).toBe("05:00"); // ≤ 5 min: seconds
    expect(formatCountdown(5 * MIN + 1)).toBe("5m"); // just over: minutes
    expect(formatCountdown(5 * MIN + 999)).toBe("5m");
    expect(formatCountdown(-5 * MIN)).toBe("+05:00");
    expect(formatCountdown(-(5 * MIN + 1))).toBe("+5m");
  });

  it("crosses minute↔hour at exactly 1 h with no skipped minute (both signs)", () => {
    expect(formatCountdown(HOUR - 1)).toBe("59m");
    expect(formatCountdown(HOUR)).toBe("1h 00");
    expect(formatCountdown(-(HOUR - 1))).toBe("+59m");
    expect(formatCountdown(-HOUR)).toBe("+1h 00");
  });
});

describe("formatMeetingHint (§8)", () => {
  it("renders a machine-local month/day date and wall-clock time", () => {
    // 2026-07-27, 09:05 local.
    expect(formatMeetingHint(new Date(2026, 6, 27, 9, 5))).toEqual({
      date: "Jul 27",
      time: "9:05",
    });
  });

  it("zero-pads minutes but not the hour or day", () => {
    expect(formatMeetingHint(new Date(2026, 7, 8, 14, 0))).toEqual({
      date: "Aug 8",
      time: "14:00",
    });
  });
});
