import { describe, expect, it } from "vitest";

import { formatCountdown, formatMeetingHint } from "./format.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("formatCountdown (§8)", () => {
  it("renders MM:SS under an hour", () => {
    expect(formatCountdown(5 * MIN)).toBe("05:00");
    expect(formatCountdown(90 * SEC)).toBe("01:30");
    expect(formatCountdown(9 * SEC)).toBe("00:09");
  });

  it("rounds remaining time up so it hits 00:00 exactly at start", () => {
    expect(formatCountdown(1)).toBe("00:01");
    expect(formatCountdown(999)).toBe("00:01");
    expect(formatCountdown(0)).toBe("00:00");
  });

  it("renders Hh MM once over an hour", () => {
    expect(formatCountdown(HOUR)).toBe("1h 00");
    expect(formatCountdown(2 * HOUR + 5 * MIN)).toBe("2h 05");
  });

  it("renders +MM:SS once overdue, counting up from +00:00", () => {
    expect(formatCountdown(-1)).toBe("+00:00");
    expect(formatCountdown(-90 * SEC)).toBe("+01:30");
    expect(formatCountdown(-1 * HOUR - 5 * MIN)).toBe("+1h 05");
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
