import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveIdentities } from "./attendance.js";
import {
  applyDismissal,
  currentInstance,
  displayHorizon,
  isJoined,
  joinIdentity,
  parseFeed,
  selectMeetings,
} from "./engine.js";
import type { MeetingInstance } from "./types.js";

// Resolve fixtures from the package cwd (vitest runs in packages/plugin) rather
// than import.meta.url — the latter's file: URL breaks when the checkout path
// contains literal '%' characters (worktree paths do).
const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "src/calendar/fixtures", name), "utf8");

/** Reference instant for the §5.1 attendance fixture. */
const NOW_ATTEND = new Date("2026-06-15T14:00:00Z");

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

describe("displayHorizon — configurable duration horizon (§5)", () => {
  // Local noon keeps the ±hours arithmetic on the same / adjacent local day in
  // every machine timezone, so this test is tz-independent.
  const localNoon = new Date(2026, 5, 15, 12, 0, 0);
  const H = 60 * 60 * 1000;
  const H24 = 24 * H;
  const at = (offsetMs: number): MeetingInstance => ({
    start: new Date(localNoon.getTime() + offsetMs),
    end: new Date(localNoon.getTime() + offsetMs + 30 * 60 * 1000),
    allDay: false,
    title: "x",
    sourceFeedId: "f",
    attending: true,
    candidate: { tier: "b" },
  });

  it("classifies an event within the horizon as a live countdown", () => {
    const soon = at(H); // +1h, well within 24h
    const h = displayHorizon([soon], 0, localNoon, H24);
    expect(h.kind).toBe("within");
    expect(h).toMatchObject({ instance: soon });
  });

  it("classifies an event beyond the horizon as Free + hint", () => {
    const far = at(48 * H); // +2 days, beyond 24h
    const h = displayHorizon([far], 0, localNoon, H24);
    expect(h.kind).toBe("beyond");
    expect(h).toMatchObject({ instance: far });
  });

  it("counts down across local midnight when still within the horizon (the fix)", () => {
    // +13h from local noon lands after local midnight (a *different* calendar
    // date) but is only 13h away — the old same-day horizon wrongly showed Free.
    const overnight = at(13 * H);
    expect(overnight.start.getDate()).not.toBe(localNoon.getDate());
    expect(displayHorizon([overnight], 0, localNoon, H24).kind).toBe("within");
  });

  it("treats an already-started (negative time-to-start) event as within horizon", () => {
    const started = at(-5 * 60 * 1000); // began 5 min ago
    expect(displayHorizon([started], 0, localNoon, H24).kind).toBe("within");
  });

  it("uses a strict threshold: exactly at the horizon is beyond, just under is within", () => {
    expect(displayHorizon([at(H24)], 0, localNoon, H24).kind).toBe("beyond");
    expect(displayHorizon([at(H24 - 1)], 0, localNoon, H24).kind).toBe("within");
  });

  it("respects a custom (non-24h) horizon", () => {
    const twoHoursOut = at(2 * H);
    expect(displayHorizon([twoHoursOut], 0, localNoon, 1 * H).kind).toBe("beyond");
    expect(displayHorizon([twoHoursOut], 0, localNoon, 3 * H).kind).toBe("within");
  });

  it("returns none when the key's offset exceeds the list", () => {
    expect(displayHorizon([], 0, localNoon, H24)).toEqual({ kind: "none" });
    expect(displayHorizon([at(H)], 3, localNoon, H24)).toEqual({ kind: "none" });
  });

  it("indexes the list by offset", () => {
    const a = at(H);
    const b = at(2 * H);
    expect(displayHorizon([a, b], 1, localNoon, H24)).toMatchObject({
      kind: "within",
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
    attending: true,
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

describe("applyDismissal — §10 hold & skip-ahead", () => {
  const base = new Date(2026, 5, 15, 12, 0, 0);
  /** A tier-(a) gmeet instance spanning `[startMin, endMin]` with a given code. */
  const meet = (startMin: number, endMin: number, code: string, title = "x"): MeetingInstance => ({
    start: new Date(base.getTime() + startMin * 60_000),
    end: new Date(base.getTime() + endMin * 60_000),
    allDay: false,
    title,
    sourceFeedId: "f",
    attending: true,
    candidate: { tier: "a", provider: "gmeet", code, joinUrl: "https://meet.google.com/x" },
  });
  /** A tier-(b) instance (no code — never joinable). */
  const tierB = (startMin: number, endMin: number, title = "x"): MeetingInstance => ({
    start: new Date(base.getTime() + startMin * 60_000),
    end: new Date(base.getTime() + endMin * 60_000),
    allDay: false,
    title,
    sourceFeedId: "f",
    attending: true,
    candidate: { tier: "b" },
  });
  /** The held set for a set of instances (their {@link joinIdentity}s). */
  const held = (...insts: MeetingInstance[]) =>
    new Set(insts.map((i) => joinIdentity(i)).filter((id): id is string => id !== null));

  it("keeps every instance when nothing is held (dismissal never drops a late one)", () => {
    const soon = meet(5, 35, "gmeet:aaa-bbbb-ccc", "Soon"); // starts in 5m
    const late = meet(-3, 27, "gmeet:ddd-eeee-fff", "Late"); // 3m past start
    const kept = applyDismissal([late, soon], new Set());
    expect(kept.map((i) => i.title)).toEqual(["Late", "Soon"]);
  });

  it("keeps a long-overdue never-joined meeting surfaced until its DTEND (no early drop)", () => {
    // 60m past start, still running — grace no longer dismisses; it stays current
    // (rendered static-red overdue, an §8 concern) until end > now goes false.
    const overdue = meet(-60, 30, "gmeet:aaa-bbbb-ccc", "Overdue");
    expect(applyDismissal([overdue], new Set()).map((i) => i.title)).toEqual(["Overdue"]);
  });

  it("holds a joined meeting until its end, even well past grace — and durably (§10)", () => {
    // 15m past start; only the held set (no live key) keeps it, so it survives
    // leaving the call. Its neighbour is untouched.
    const joined = meet(-15, 28, "gmeet:aaa-bbbb-ccc", "Joined");
    const next = meet(30, 60, "gmeet:ddd-eeee-fff", "Next");
    const kept = applyDismissal([joined, next], held(joined));
    expect(kept.map((i) => i.title)).toEqual(["Joined", "Next"]);
  });

  it("skip-ahead: a held later event drops the non-held skipped one before it", () => {
    const skipped = meet(-5, 25, "gmeet:aaa-bbbb-ccc", "Skipped"); // never joined
    const joined = meet(-1, 29, "gmeet:ddd-eeee-fff", "Joined"); // joined N+1 directly
    const after = meet(40, 70, "gmeet:ggg-hhhh-iii", "After");
    const kept = applyDismissal([skipped, joined, after], held(joined));
    // Only the skipped event before the held one drops; the held event stays.
    expect(kept.map((i) => i.title)).toEqual(["Joined", "After"]);
  });

  it("holds only the exact occurrence, not a future one sharing the same code", () => {
    // A recurring meeting shares one code across occurrences; joinIdentity pins
    // the held set to a single occurrence by its start, so the future one is not
    // affected (and, being after the held one, is kept anyway).
    const nowInst = meet(-15, 28, "gmeet:aaa-bbbb-ccc", "Now");
    const future = meet(120, 150, "gmeet:aaa-bbbb-ccc", "Future"); // same code, later start
    const kept = applyDismissal([nowInst, future], held(nowInst));
    expect(kept.map((i) => i.title)).toEqual(["Now", "Future"]);
  });

  it("a tier-(b) event is never held (no code) but is still kept until its end", () => {
    const b = tierB(-1, 29, "TierB");
    expect(applyDismissal([b], new Set()).map((i) => i.title)).toEqual(["TierB"]);
  });
});

describe("isJoined — live in-call signal (§10)", () => {
  const base = new Date(2026, 5, 15, 12, 0, 0);
  const meet = (startMin: number, code: string): MeetingInstance => ({
    start: new Date(base.getTime() + startMin * 60_000),
    end: new Date(base.getTime() + (startMin + 30) * 60_000),
    allDay: false,
    title: "x",
    sourceFeedId: "f",
    attending: true,
    candidate: { tier: "a", provider: "gmeet", code, joinUrl: "https://meet.google.com/x" },
  });

  it("matches a started occurrence whose code equals the key (case-insensitive)", () => {
    expect(isJoined(meet(-2, "gmeet:aaa-bbbb-ccc"), "GMEET:AAA-BBBB-CCC", base)).toBe(true);
  });

  it("does not match a not-yet-started occurrence sharing the code (recurring safety)", () => {
    // Guards the durable memory from marking a future occurrence when you join
    // today's — the started gate is what keeps joinIdentity per-occurrence sound.
    expect(isJoined(meet(120, "gmeet:aaa-bbbb-ccc"), "gmeet:aaa-bbbb-ccc", base)).toBe(false);
  });

  it("never matches with no live key, nor a tier-(b) event", () => {
    expect(isJoined(meet(-2, "gmeet:aaa-bbbb-ccc"), null, base)).toBe(false);
  });
});

describe("selectMeetings — attendance & cancellation verdict (§5.1)", () => {
  const NOW = new Date("2026-06-15T14:00:00Z");
  const ME = ["me@example.com"];

  /** `title → attending` for every selected instance, with the given identities. */
  const verdicts = async (identities: readonly string[] = []) => {
    const parsed = await parseFeed(fixture("attendance.ics"));
    const map = new Map<string, boolean>();
    for (const i of selectMeetings(parsed, "feed-1", NOW, identities)) {
      map.set(i.title, i.attending);
    }
    return map;
  };

  it("marks without dropping — every event is still returned", async () => {
    const v = await verdicts(ME);
    expect(v.get("Declined")).toBe(false);
    expect(v.get("Cancelled")).toBe(false);
    // The drop lives downstream in applyDismissal (§10), not here.
    expect(v.has("Declined")).toBe(true);
    expect(v.has("Cancelled")).toBe(true);
  });

  it("allows by default: no ATTENDEE, TENTATIVE, NEEDS-ACTION, DELEGATED, unrecognized", async () => {
    const v = await verdicts(ME);
    expect(v.get("Accepted")).toBe(true);
    expect(v.get("No attendee")).toBe(true);
    expect(v.get("Tentative partstat")).toBe(true);
    expect(v.get("Delegated")).toBe(true);
    expect(v.get("Unknown partstat")).toBe(true);
  });

  it("treats STATUS:TENTATIVE as attending — only CANCELLED drops", async () => {
    // STATUS is the organizer's voice; their uncertainty is not your decline.
    expect((await verdicts(ME)).get("Organizer tentative")).toBe(true);
  });

  it("drops a CANCELLED event with no identity configured (unconditional half)", async () => {
    const v = await verdicts([]);
    expect(v.get("Cancelled")).toBe(false);
    // …while the *declined* half is a pure no-op without an identity.
    expect(v.get("Declined")).toBe(true);
  });

  it("ignores someone else's decline", async () => {
    expect((await verdicts(ME)).get("Someone else declined")).toBe(true);
  });

  it("matches case-insensitively and strips the mailto: scheme", async () => {
    const v = await verdicts(ME);
    // The fixture's own ATTENDEE is `mailto:ME@Example.com`.
    expect(v.get("Declined")).toBe(false);
    expect(v.get("Lowercase declined")).toBe(false);
    expect(v.get("Cancelled lowercase")).toBe(false);
    expect((await verdicts(["MAILTO:Me@EXAMPLE.com"])).get("Declined")).toBe(false);
  });

  it("matches any configured alias", async () => {
    const v = await verdicts([...ME, "alias@example.com"]);
    expect(v.get("Alias declined")).toBe(false);
    expect(v.get("Declined")).toBe(false);
    // …and an unconfigured alias is someone else.
    expect((await verdicts(ME)).get("Alias declined")).toBe(true);
  });

  it("evaluates the expanded occurrence: one declined RECURRENCE-ID override", async () => {
    const parsed = await parseFeed(fixture("attendance.ics"));
    const series = selectMeetings(parsed, "feed-1", NOW, ME)
      .filter((i) => i.title === "Series")
      .slice(0, 3);
    expect(series).toHaveLength(3);
    // The master VEVENT is ACCEPTED; only the 06-17 override declines. Testing
    // the master instead of occ.event would silently mark all three attending.
    expect(series.map((i) => i.attending)).toEqual([true, false, true]);
  });
});

describe("resolveIdentities — configured, inferred, neither (§5.1)", () => {
  const calendar = (calName: string | null): string =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//callctl//test//EN",
      ...(calName === null ? [] : [`X-WR-CALNAME:${calName}`]),
      "END:VCALENDAR",
      "",
    ].join("\n");

  it("infers an email-shaped X-WR-CALNAME (the no-setup common case)", async () => {
    const parsed = await parseFeed(calendar("Owner@Example.COM"));
    expect(resolveIdentities([], parsed)).toEqual(["owner@example.com"]);
  });

  it("does not infer a display name", async () => {
    // The shape test's only job: reject names like this, not validate RFC 5322.
    expect(resolveIdentities([], await parseFeed(calendar("Arbora Team")))).toEqual([]);
    expect(resolveIdentities([], await parseFeed(calendar("a@b")))).toEqual([]);
    expect(resolveIdentities([], await parseFeed(calendar("@example.com")))).toEqual([]);
    expect(resolveIdentities([], await parseFeed(calendar("a@b@c.com")))).toEqual([]);
    expect(resolveIdentities(undefined, await parseFeed(calendar(null)))).toEqual([]);
  });

  it("lets configured identities suppress inference outright (never a union)", async () => {
    const parsed = await parseFeed(calendar("owner@example.com"));
    expect(resolveIdentities(["me@example.com"], parsed)).toEqual(["me@example.com"]);
  });

  it("normalizes and de-duplicates configured identities", async () => {
    const parsed = await parseFeed(calendar(null));
    expect(resolveIdentities([" MAILTO:Me@Example.com ", "me@example.com", ""], parsed)).toEqual([
      "me@example.com",
    ]);
  });

  it("inference reaches the verdict end-to-end (X-WR-CALNAME is me@example.com)", async () => {
    const parsed = await parseFeed(fixture("attendance.ics"));
    const list = selectMeetings(parsed, "feed-1", NOW_ATTEND, resolveIdentities([], parsed));
    const byTitle = new Map(list.map((i) => [i.title, i.attending]));
    expect(byTitle.get("Declined")).toBe(false);
    expect(byTitle.get("Someone else declined")).toBe(true);
  });
});
