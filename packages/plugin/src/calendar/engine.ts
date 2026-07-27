/**
 * Parse, recurrence expansion & ordered selection (§5) — the pure calendar
 * engine. Given raw iCal text it produces the ordered list of upcoming,
 * link-bearing {@link MeetingInstance}s a key selects from by `offset`, plus the
 * today-only display-horizon classification (§5 "Display horizon = today only").
 *
 * UI-agnostic: no Stream Deck imports, testable in a plain node context. All
 * recurrence, DST, and timezone correctness is delegated to `node-ical`, whose
 * bundled tz data resolves a bare `TZID` with no `VTIMEZONE` correctly (the
 * decisive reason it was chosen over `ical.js`; §5, #47).
 */

import type { CalendarResponse, VEvent } from "node-ical";
import ical from "node-ical";
import { extractJoinCandidate } from "./extract.js";
import type { DisplayHorizon, MeetingInstance, ParsedEvent } from "./types.js";

/** Recurrence horizon: expand no further than ~400 days out (§5). Never unbounded. */
const HORIZON_DAYS = 400;
/** Synthesized meeting length when `DTEND` is absent (§5). */
const SYNTH_DURATION_MS = 30 * 60 * 1000;

/** Parse raw iCal text into node-ical's component map (§4/§5). */
export async function parseFeed(text: string): Promise<CalendarResponse> {
  return ical.async.parseICS(text);
}

/** Unwrap a node-ical `ParameterValue` (`string` | `{ params, val }`) to a plain string. */
function readSummary(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "string") {
    return (v as { val: string }).val;
  }
  return "";
}

/**
 * Select the ordered list of upcoming, still-relevant, **link-bearing** event
 * instances (§5). Steps, in order:
 *
 * 1. Expand every `VEVENT`'s recurrences over `[now, now + ~400d]`
 *    (`expandOngoing` so an in-progress meeting still surfaces).
 * 2. Synthesize `end = start + 30 min` when the source carries no `DTEND`.
 * 3. Keep instances whose `end > now`.
 * 4. Filter to instances that yield a join candidate (§6 — tiers (a) and (b)
 *    both count; tier (c) is dropped).
 * 5. Stable-sort `start ↑ → end ↑ → uid`.
 *
 * @param parsed  a {@link parseFeed} result.
 * @param feedId  the `id` of the feed these events came from — stamped on each instance.
 * @param now     the reference instant (injected for determinism/testing).
 */
export function selectMeetings(
  parsed: CalendarResponse,
  feedId: string,
  now: Date,
): MeetingInstance[] {
  const from = new Date(now.getTime() - SYNTH_DURATION_MS); // catch just-started no-DTEND meetings
  const to = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const nowMs = now.getTime();

  // Carry uid alongside each instance purely for the sort tiebreak (§5) — it is
  // not part of the returned MeetingInstance shape.
  const rows: Array<{ instance: MeetingInstance; uid: string }> = [];

  for (const component of Object.values(parsed)) {
    if (!component || (component as { type?: string }).type !== "VEVENT") continue;
    const event = component as VEvent;

    for (const occ of ical.expandRecurringEvent(event, { from, to, expandOngoing: true })) {
      const start = occ.start;
      // node-ical sets end = start (zero duration) when DTEND is absent; treat any
      // non-positive-duration timed occurrence as "no DTEND" and synthesize +30 min (§5).
      const end =
        !occ.isFullDay && occ.end.getTime() <= start.getTime()
          ? new Date(start.getTime() + SYNTH_DURATION_MS)
          : occ.end;

      if (end.getTime() <= nowMs) continue; // keep only end > now

      const candidate = extractJoinCandidate(occ.event as unknown as ParsedEvent);
      if (candidate === null) continue; // tier (c) — no link, dropped

      rows.push({
        instance: {
          start,
          end,
          allDay: occ.isFullDay,
          title: readSummary(occ.summary),
          sourceFeedId: feedId,
          candidate,
        },
        uid: event.uid ?? "",
      });
    }
  }

  rows.sort((a, b) => {
    const s = a.instance.start.getTime() - b.instance.start.getTime();
    if (s !== 0) return s;
    const e = a.instance.end.getTime() - b.instance.end.getTime();
    if (e !== 0) return e;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });

  return rows.map((r) => r.instance);
}

/** `true` iff two instants fall on the same machine-local calendar date (§5). */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The still-current-or-upcoming instance a key at `offset` points at *right now*
 * (§9 meeting-boundary behavior). `selectMeetings` drops ended events only at
 * **poll** time; between polls the cache is static, so the render clock must
 * itself skip any instance whose `end` has since passed. Filtering `end > now`
 * here is the boundary advance: as each event ends it falls out of the view and
 * every key's `offset` shifts to the next element — the two-buttons-per-calendar
 * keys "re-index the same list, shift together at each boundary" (§9). `offset`
 * indexes into this filtered view, not the raw list.
 *
 * @param list    a {@link selectMeetings} result (ordered `start ↑ → end ↑ → uid`).
 * @param offset  the key's index into the still-current view (§3; default 0).
 * @param now     the reference instant (injected by the render clock).
 */
export function currentInstance(
  list: MeetingInstance[],
  offset: number,
  now: Date,
): MeetingInstance | undefined {
  const nowMs = now.getTime();
  return list.filter((i) => i.end.getTime() > nowMs)[offset];
}

/**
 * Classify what the key at `offset` should show, applying the today-only display
 * horizon (§5) over the still-current view ({@link currentInstance}, §9). The
 * countdown only counts to an event **starting today** (machine-local date); a
 * future-day event yields a "Free" + hint face; no still-current event at that
 * offset yields a plain "Free". The horizon rolls over at local midnight and the
 * boundary advances as events end, because both are re-derived from `now` on
 * every render tick.
 *
 * @param list    a {@link selectMeetings} result (ordered).
 * @param offset  the key's index into the still-current view (§3; default 0).
 * @param now     the reference instant.
 */
export function displayHorizon(list: MeetingInstance[], offset: number, now: Date): DisplayHorizon {
  const instance = currentInstance(list, offset, now);
  if (!instance) return { kind: "none" };
  return isSameLocalDay(instance.start, now)
    ? { kind: "today", instance }
    : { kind: "future", instance };
}
