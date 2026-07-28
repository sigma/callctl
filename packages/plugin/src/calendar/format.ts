/**
 * Pure countdown / hint formatting for the render clock (§8). No Stream Deck or
 * network imports — the 500 ms render tick does nothing but `now`-vs-cached-set
 * arithmetic and feeds the result through here (§9).
 */

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

const MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The two-line "Free"-face signpost: a calendar date and a wall-clock time. */
export interface MeetingHint {
  /** Month + day, e.g. `Aug 11` — un-abbreviated day, month name. */
  date: string;
  /** Wall-clock `H:MM`, e.g. `9:05` / `17:00` (hour un-padded, minutes zero-padded). */
  time: string;
}

/** `MM:SS`, or `Hh MM` once past an hour. */
function clock(totalSec: number): string {
  if (totalSec >= 3600) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${pad2(m)}`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

/**
 * Format the time-to-start as the key countdown (§8):
 * - `MM:SS` under an hour, `Hh MM` over an hour,
 * - `+MM:SS` (or `+Hh MM`) once overdue.
 *
 * Remaining time rounds **up** so the key reads `00:01` for the final second and
 * hits `00:00` exactly at start; elapsed time (overdue) rounds **down** so it
 * begins at `+00:00`.
 *
 * @param msRemaining  `instance.start - now` in ms (negative once started).
 */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining < 0) {
    return `+${clock(Math.floor(-msRemaining / 1000))}`;
  }
  return clock(Math.ceil(msRemaining / 1000));
}

/**
 * The next-meeting hint for the "Free" face when the next in-scope event starts
 * further out than the countdown horizon (§8). Returns an explicit **date** and
 * **time** (e.g. `{ date: "Aug 11", time: "17:00" }`) rather than a weekday, so a
 * meeting weeks out is unambiguous — a bare weekday repeats and can't be placed.
 * Uses the machine-local date and wall-clock time (§5 "Displayed times … use the
 * machine-local timezone").
 */
export function formatMeetingHint(start: Date): MeetingHint {
  return {
    date: `${MONTH[start.getMonth()]} ${start.getDate()}`,
    time: `${start.getHours()}:${pad2(start.getMinutes())}`,
  };
}
