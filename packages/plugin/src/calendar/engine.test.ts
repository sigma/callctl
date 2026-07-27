import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDismissal,
  currentInstance,
  displayHorizon,
  parseFeed,
  selectMeetings,
} from "./engine.js";
import type { MeetingInstance } from "./types.js";

// Resolve fixtures from the package cwd (vitest runs in packages/plugin) rather
// than import.meta.url — the latter's file: URL breaks when the checkout path
// contains literal '%' characters (worktree paths do).
const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "src/calendar/fixtures", name), "utf8");

/** Wall-clock in a named zone, e.g. "09:00", for DST assertions. */
const wallClock = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

describe("selectMeetings — ordering, filtering, synthesis (§5)", () => {
  const NOW = new Date("2026-06-15T14:00:00Z");
  let list: MeetingInstance[];

  it("parses and selects", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    list = selectMeetings(parsed, "feed-1", NOW);
    expect(list.length).toBeGreaterThan(0);
  });

  it("returns the link-bearing events ordered start↑ → end↑ → uid", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const got = selectMeetings(parsed, "feed-1", NOW).map((m) => m.title);
    expect(got).toEqual([
      "In progress", // 13:45–14:30, still running (end > now)
      "Soon A", // 15:00
      "Pair short", // 16:00–16:30  (end↑ tiebreak before Pair long)
      "Pair long", // 16:00–17:00
      "Zoom sync", // 18:00
      "No DTEND", // 19:00 (+30 synth)
      "Tie A", // 20:00–20:30 uid-aaa (uid tiebreak before Tie B)
      "Tie B", // 20:00–20:30 uid-bbb
      "Tomorrow", // next-day 09:00
    ]);
  });

  it("drops past events (end ≤ now) and link-less events (tier c)", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const titles = selectMeetings(parsed, "feed-1", NOW).map((m) => m.title);
    expect(titles).not.toContain("Past");
    expect(titles).not.toContain("No link");
  });

  it("keeps an in-progress meeting (start < now < end)", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const inProgress = selectMeetings(parsed, "feed-1", NOW)[0];
    expect(inProgress.title).toBe("In progress");
    expect(inProgress.start.getTime()).toBeLessThan(NOW.getTime());
    expect(inProgress.end.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("synthesizes end = start + 30 min when DTEND is absent", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const noEnd = selectMeetings(parsed, "feed-1", NOW).find((m) => m.title === "No DTEND");
    if (!noEnd) throw new Error("expected a 'No DTEND' instance");
    expect(noEnd.end.toISOString()).toBe("2026-06-15T19:30:00.000Z");
    expect(noEnd.end.getTime() - noEnd.start.getTime()).toBe(30 * 60 * 1000);
  });

  it("stamps the source feed id on every instance", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const all = selectMeetings(parsed, "feed-xyz", NOW);
    expect(all.every((m) => m.sourceFeedId === "feed-xyz")).toBe(true);
  });

  it("carries the canonicalized §6 join candidate (Meet + Zoom)", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const all = selectMeetings(parsed, "feed-1", NOW);
    const candidateOf = (title: string) => {
      const m = all.find((x) => x.title === title);
      if (!m) throw new Error(`expected an instance titled ${title}`);
      return m.candidate;
    };
    expect(candidateOf("Soon A")).toMatchObject({
      tier: "a",
      provider: "gmeet",
      code: "gmeet:uvw-xyza-bcd",
      joinUrl: "https://meet.google.com/uvw-xyza-bcd",
    });
    expect(candidateOf("Zoom sync")).toMatchObject({
      tier: "a",
      provider: "zoom",
      joinUrl: "https://zoom.us/j/1234567890",
    });
  });

  it("maps offset N to the Nth element of the ordered list (§3)", async () => {
    const parsed = await parseFeed(fixture("selection.ics"));
    const all = selectMeetings(parsed, "feed-1", NOW);
    expect(all[0].title).toBe("In progress");
    expect(all[1].title).toBe("Soon A");
    expect(all[4].title).toBe("Zoom sync");
  });
});

describe("selectMeetings — recurrence & DST (§5)", () => {
  // Before the whole series so all 10 daily instances survive `end > now`.
  const NOW = new Date("2026-03-04T00:00:00Z");

  it("expands a bare-TZID (no VTIMEZONE) recurrence, holding wall-clock across spring-forward", async () => {
    const parsed = await parseFeed(fixture("dst.ics"));
    const list = selectMeetings(parsed, "ny", NOW);
    expect(list).toHaveLength(10);
    // Every instance stays 09:00 America/New_York — the DST-correctness invariant.
    for (const m of list) {
      expect(wallClock(m.start, "America/New_York")).toBe("09:00");
    }
    // DST begins 2026-03-08: EST (UTC−5 ⇒ 14:00Z) before, EDT (UTC−4 ⇒ 13:00Z) after.
    expect(list[0].start.toISOString()).toBe("2026-03-05T14:00:00.000Z"); // Mar 5, EST
    expect(list[5].start.toISOString()).toBe("2026-03-10T13:00:00.000Z"); // Mar 10, EDT
  });

  it("bounds the horizon — an unbounded weekly series does not run past ~400 days", async () => {
    const parsed = await parseFeed(fixture("dst.ics"));
    const list = selectMeetings(parsed, "ny", NOW);
    // COUNT=10 caps this series anyway; the guarantee under test is that the call
    // returns (does not hang materializing an infinite series) and stays bounded.
    expect(list.length).toBeLessThanOrEqual(10);
  });
});

describe("displayHorizon — today-only horizon (§5)", () => {
  // Local noon keeps the ±hours arithmetic on the same / adjacent local day in
  // every machine timezone, so this test is tz-independent.
  const localNoon = new Date(2026, 5, 15, 12, 0, 0);
  const at = (offsetMs: number): MeetingInstance => ({
    start: new Date(localNoon.getTime() + offsetMs),
    end: new Date(localNoon.getTime() + offsetMs + 30 * 60 * 1000),
    allDay: false,
    title: "x",
    sourceFeedId: "f",
    candidate: { tier: "b" },
  });

  it("classifies a same-local-day event as a live countdown (today)", () => {
    const today = at(60 * 60 * 1000); // +1h, same local day
    const h = displayHorizon([today], 0, localNoon);
    expect(h.kind).toBe("today");
    expect(h).toMatchObject({ instance: today });
  });

  it("classifies a future-day event as Free + hint (future)", () => {
    const future = at(48 * 60 * 60 * 1000); // +2 days, a different local date
    const h = displayHorizon([future], 0, localNoon);
    expect(h.kind).toBe("future");
    expect(h).toMatchObject({ instance: future });
  });

  it("returns none when the key's offset exceeds the list", () => {
    expect(displayHorizon([], 0, localNoon)).toEqual({ kind: "none" });
    expect(displayHorizon([at(3600_000)], 3, localNoon)).toEqual({ kind: "none" });
  });

  it("indexes the list by offset", () => {
    const a = at(60 * 60 * 1000);
    const b = at(2 * 60 * 60 * 1000);
    expect(displayHorizon([a, b], 1, localNoon)).toMatchObject({
      kind: "today",
      instance: b,
    });
  });
});

describe("currentInstance — boundary advance (§9)", () => {
  const base = new Date(2026, 5, 15, 12, 0, 0);
  /** An instance spanning `[startMin, endMin]` minutes relative to `base`. */
  const span = (startMin: number, endMin: number, title = "x"): MeetingInstance => ({
    start: new Date(base.getTime() + startMin * 60_000),
    end: new Date(base.getTime() + endMin * 60_000),
    allDay: false,
    title,
    sourceFeedId: "f",
    candidate: { tier: "b" },
  });

  it("keeps a still-running meeting current until its end", () => {
    const running = span(-10, 20, "Running"); // started 10m ago, ends in 20m
    const next = span(30, 60, "Next");
    // Before the boundary, offset 0 is still the running meeting.
    expect(currentInstance([running, next], 0, base)?.title).toBe("Running");
  });

  it("advances every offset past a meeting once its end passes", () => {
    const ended = span(-40, -10, "Ended"); // ended 10m ago
    const running = span(-5, 25, "Running");
    const next = span(30, 60, "Next");
    const list = [ended, running, next];
    // The ended meeting has dropped out of the view; offsets re-index the rest.
    expect(currentInstance(list, 0, base)?.title).toBe("Running");
    expect(currentInstance(list, 1, base)?.title).toBe("Next");
    // Two keys on one feed shift together at the boundary — offset 1 was "Next"
    // before "Ended" dropped only because "Ended" occupied index 0.
  });

  it("returns undefined when every remaining event has ended", () => {
    const a = span(-40, -20);
    const b = span(-15, -5);
    expect(currentInstance([a, b], 0, base)).toBeUndefined();
  });

  it("an end exactly at now is already past (end > now is strict)", () => {
    const justEnded = span(-30, 0, "JustEnded"); // end === base
    const next = span(5, 35, "Next");
    expect(currentInstance([justEnded, next], 0, base)?.title).toBe("Next");
  });
});

describe("applyDismissal — late-state dismissal (§10)", () => {
  const base = new Date(2026, 5, 15, 12, 0, 0);
  /** A tier-(a) gmeet instance spanning `[startMin, endMin]` with a given code. */
  const meet = (startMin: number, endMin: number, code: string, title = "x"): MeetingInstance => ({
    start: new Date(base.getTime() + startMin * 60_000),
    end: new Date(base.getTime() + endMin * 60_000),
    allDay: false,
    title,
    sourceFeedId: "f",
    candidate: { tier: "a", provider: "gmeet", code, joinUrl: "https://meet.google.com/x" },
  });
  /** A tier-(b) instance (no code — can only be grace-dismissed). */
  const tierB = (startMin: number, endMin: number, title = "x"): MeetingInstance => ({
    start: new Date(base.getTime() + startMin * 60_000),
    end: new Date(base.getTime() + endMin * 60_000),
    allDay: false,
    title,
    sourceFeedId: "f",
    candidate: { tier: "b" },
  });

  it("keeps a still-upcoming or freshly-late event with no join proof", () => {
    const soon = meet(5, 35, "gmeet:aaa-bbbb-ccc", "Soon"); // starts in 5m
    const late = meet(-3, 27, "gmeet:ddd-eeee-fff", "Late"); // 3m past start, within grace
    const kept = applyDismissal([late, soon], base, 10, null);
    expect(kept.map((i) => i.title)).toEqual(["Late", "Soon"]);
  });

  it("grace fallback dismisses once start + graceMinutes has passed", () => {
    const overGrace = meet(-11, 19, "gmeet:aaa-bbbb-ccc", "OverGrace"); // 11m past start, grace 10
    const next = meet(20, 50, "gmeet:ddd-eeee-fff", "Next");
    const kept = applyDismissal([overGrace, next], base, 10, null);
    expect(kept.map((i) => i.title)).toEqual(["Next"]);
  });

  it("grace boundary is exclusive-of-now at exactly start + grace", () => {
    const atGrace = meet(-10, 20, "gmeet:aaa-bbbb-ccc", "AtGrace"); // start + 10m === now
    expect(applyDismissal([atGrace], base, 10, null)).toEqual([]);
  });

  it("join proof dismisses the matched event and advances to the next", () => {
    const joined = meet(-2, 28, "gmeet:aaa-bbbb-ccc", "Joined");
    const next = meet(30, 60, "gmeet:ddd-eeee-fff", "Next");
    const kept = applyDismissal([joined, next], base, 10, "gmeet:aaa-bbbb-ccc");
    expect(kept.map((i) => i.title)).toEqual(["Next"]);
  });

  it("windowed match skips past everything up to and including a later join (skip-ahead to N+1)", () => {
    const skipped = meet(-5, 25, "gmeet:aaa-bbbb-ccc", "Skipped"); // never joined
    const joined = meet(-1, 29, "gmeet:ddd-eeee-fff", "Joined"); // joined N+1 directly
    const after = meet(40, 70, "gmeet:ggg-hhhh-iii", "After");
    const kept = applyDismissal([skipped, joined, after], base, 30, "gmeet:ddd-eeee-fff");
    // Both the skipped and the joined event drop out; the key advances to "After".
    expect(kept.map((i) => i.title)).toEqual(["After"]);
  });

  it("matches the join key case-insensitively", () => {
    const joined = meet(-1, 29, "gmeet:aaa-bbbb-ccc", "Joined");
    expect(applyDismissal([joined], base, 30, "GMEET:AAA-BBBB-CCC")).toEqual([]);
  });

  it("a tier-(b) event never matches a join key (only grace can dismiss it)", () => {
    const b = tierB(-1, 29, "TierB");
    // Not join-dismissed (no code) and within grace ⇒ still surfaced.
    expect(applyDismissal([b], base, 30, "gmeet:aaa-bbbb-ccc").map((i) => i.title)).toEqual([
      "TierB",
    ]);
  });

  it("null join key leaves the grace path as the only dismissal (extension absent)", () => {
    const late = meet(-3, 27, "gmeet:aaa-bbbb-ccc", "Late");
    expect(applyDismissal([late], base, 10, null).map((i) => i.title)).toEqual(["Late"]);
  });
});
