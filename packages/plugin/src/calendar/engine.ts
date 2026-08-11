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
import { isAttending } from "./attendance.js";
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
 * 5. **Mark** each survivor with the §5.1 attendance verdict ({@link isAttending},
 *    evaluated on the *expanded occurrence* so a `RECURRENCE-ID` override's own
 *    `STATUS`/`PARTSTAT` is what counts). This step marks and **does not drop** —
 *    the drop is one clause in {@link applyDismissal}, which is what makes a
 *    declined-then-joined meeting rescuable.
 * 6. Stable-sort `start ↑ → end ↑ → uid`.
 *
 * @param parsed      a {@link parseFeed} result.
 * @param feedId      the `id` of the feed these events came from — stamped on each instance.
 * @param now         the reference instant (injected for determinism/testing).
 * @param identities  the feed's **resolved** identities ({@link resolveIdentities}) — i.e.
 *                    configured-or-inferred, already collapsed. Empty (the default) makes
 *                    the declined half of the verdict a no-op; the *cancelled* half still
 *                    fires, so an unidentifiable feed fails toward showing the meeting.
 */
export function selectMeetings(
  parsed: CalendarResponse,
  feedId: string,
  now: Date,
  identities: readonly string[] = [],
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

      const parsedEvent = occ.event as unknown as ParsedEvent;
      const candidate = extractJoinCandidate(parsedEvent);
      if (candidate === null) continue; // tier (c) — no link, dropped

      rows.push({
        instance: {
          start,
          end,
          allDay: occ.isFullDay,
          title: readSummary(occ.summary),
          sourceFeedId: feedId,
          candidate,
          attending: isAttending(parsedEvent, identities),
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

/**
 * The durable identity of a joinable **occurrence** (§10): its canonical
 * `<provider>:<code>` paired with this occurrence's start instant, or `null` for
 * a tier-(b) event (no code — never joinable). The start pins it to *one*
 * occurrence: a recurring meeting shares a single Meet code across every
 * occurrence, so the code alone would conflate them. The plugin remembers these
 * identities for meetings you have joined this session (see `heldKeys` below).
 */
export function joinIdentity(inst: MeetingInstance): string | null {
  const c = inst.candidate;
  if (c.tier !== "a" || c.code === undefined) return null;
  return `${c.code.toLowerCase()}@${inst.start.getTime()}`;
}

/**
 * Whether `inst` is the call you are **currently in** (§10): a tier-(a) instance
 * whose canonical code matches the live `joinedKey` (case-insensitive) *and that
 * has already started* (`start ≤ now`). The started gate matters because a
 * recurring meeting shares one Meet code across every occurrence — without it,
 * joining today's occurrence would match next week's too. This is the *live*
 * signal the plugin samples to grow its durable {@link joinIdentity} memory; the
 * held state ({@link applyDismissal}/`heldKeys`) is what survives leaving.
 *
 * @param inst       an ordered {@link selectMeetings} instance.
 * @param joinedKey  the §10 live join key (e.g. `"gmeet:abc-def-ghi"`), or `null`.
 * @param now        the reference instant.
 */
export function isJoined(inst: MeetingInstance, joinedKey: string | null, now: Date): boolean {
  if (!joinedKey) return false;
  const c = inst.candidate;
  return (
    c.tier === "a" &&
    c.code !== undefined &&
    c.code.toLowerCase() === joinedKey.toLowerCase() &&
    inst.start.getTime() <= now.getTime()
  );
}

/**
 * Apply §10 **dismissal** to the ordered list, returning only the instances a
 * key should still surface. This is the pre-filter the render clock and press
 * handler run before {@link currentInstance} / {@link displayHorizon}.
 *
 * Every instance stays current until its own `DTEND` (§9) — dismissal here never
 * drops a meeting merely for being late. A never-joined late meeting keeps
 * surfacing (its flash calms to a static state at the fixed §10 grace window past
 * `start`, an §8 *render* concern — not this function's) until `DTEND`, at which point
 * {@link currentInstance}'s `end > now` filter advances the key like any other
 * boundary. A **held** meeting (one whose {@link joinIdentity} is in `heldKeys`,
 * i.e. you joined it this session) is likewise kept until its `DTEND`, rendered
 * as the calm in-call countdown (§8); this is **durable** — it survives leaving
 * the call (the live signal clears but the identity is remembered), so the late
 * flash never resumes for a meeting you already joined.
 *
 * What dismissal *does* drop is:
 *
 * - **Skip-ahead casualties:** when you join a later event directly (skipping
 *   event N to join N+1), every *non-held* instance before the latest held one is
 *   dropped so the key advances to the held event you are actually in.
 * - **Non-attending instances** (§5.1): `attending: false` — you declined it, or
 *   the organizer cancelled it — unless it is held. Being held is the single door
 *   back in, and it rescues a declined and a `STATUS:CANCELLED` instance on the
 *   same clause: its trigger is that you are demonstrably *in* this call, which
 *   outranks both the organizer's voice and your own earlier RSVP. The rescue
 *   rides the durable held set, never the live join signal, so it survives leaving
 *   the call; and since held *is* the calm in-call state (§8), a rescued meeting
 *   can never flash. A **tier-(b)** instance has no {@link joinIdentity} and so can
 *   never be held — a declined link-in-the-description meeting stays dropped. That
 *   is a known spec limitation (§5.1), not a bug.
 *
 * A **press never counts as join-proof** (§10): only a real join affects this —
 * this function never sees a press.
 *
 * @param list      a {@link selectMeetings} result (ordered `start ↑ → end ↑ → uid`).
 * @param heldKeys  {@link joinIdentity} strings of meetings joined this session.
 */
export function applyDismissal(
  list: MeetingInstance[],
  heldKeys: ReadonlySet<string>,
): MeetingInstance[] {
  const held = (inst: MeetingInstance): boolean => {
    const id = joinIdentity(inst);
    return id !== null && heldKeys.has(id);
  };
  // Latest held index: non-held instances *before* it are skip-ahead casualties.
  let lastHeld = -1;
  for (let i = 0; i < list.length; i++) {
    if (held(list[i])) lastHeld = i;
  }

  return list.filter((inst, i) => {
    if (held(inst)) return true; // joined this session → hold until DTEND (§9), never re-flash
    if (!inst.attending) return false; // §5.1: declined or cancelled, and not rescued by a hold
    return i >= lastHeld; // keep, except non-held events skipped before the latest held one
  });
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
 * Classify what the key at `offset` should show, applying the configurable
 * display horizon (§5) over the still-current view ({@link currentInstance}, §9).
 * The countdown counts to an event starting **less than `horizonMs` from now**
 * (an already-started, not-yet-dismissed event has a negative time-to-start and
 * is always within horizon); an event further off yields a "Free" + hint face;
 * no still-current event at that offset yields a plain "Free". The horizon is a
 * duration, not a calendar day, so a meeting straddling local midnight is judged
 * by how soon it is — re-derived from `now` on every render tick, so it also
 * advances as events end.
 *
 * @param list      a {@link selectMeetings} result (ordered).
 * @param offset    the key's index into the still-current view (§3; default 0).
 * @param now       the reference instant.
 * @param horizonMs the key's countdown horizon in ms (§3; default 24h).
 */
export function displayHorizon(
  list: MeetingInstance[],
  offset: number,
  now: Date,
  horizonMs: number,
): DisplayHorizon {
  const instance = currentInstance(list, offset, now);
  if (!instance) return { kind: "none" };
  return instance.start.getTime() - now.getTime() < horizonMs
    ? { kind: "within", instance }
    : { kind: "beyond", instance };
}
