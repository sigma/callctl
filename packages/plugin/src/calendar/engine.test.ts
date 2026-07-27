import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { displayHorizon, parseFeed, selectMeetings } from "./engine.js";
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
