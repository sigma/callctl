import { describe, expect, it } from "vitest";

import { computeFace, type FaceInput } from "./face.js";
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
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 27, 9, 5), "Sync")] }));
    expect(face).toEqual({ kind: "countdown", title: "Sync", time: "05:00", overdue: false });
  });

  it("marks an already-started event overdue with a +MM:SS count-up", () => {
    const now = new Date(2026, 6, 27, 9, 0);
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 27, 8, 59), "Sync")] }));
    expect(face.kind).toBe("countdown");
    if (face.kind === "countdown") {
      expect(face.overdue).toBe(true);
      expect(face.time).toBe("+01:00");
    }
  });

  it("shows Free + a day hint when the next event is a future day", () => {
    const now = new Date(2026, 6, 27, 9, 0); // Mon
    const face = computeFace(base({ now, list: [instance(new Date(2026, 6, 28, 9, 0))] })); // Tue
    expect(face).toEqual({ kind: "free", hint: "Tue 9:00" });
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
