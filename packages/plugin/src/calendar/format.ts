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

/**
 * The half-width of the seconds window: `formatCountdown` shows `MM:SS` iff the
 * time to (or past) its target is within this of zero — contract #1. Exported so
 * the render clock reuses the *same* value for its seconds↔minute tier boundary,
 * with no drift between what the key displays and how fast it repaints.
 */
export const SECONDS_WINDOW_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** `MM:SS` — sub-hour minutes and seconds. */
function mmss(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

/** `Hh MM` — hours and zero-padded minutes, for the ≥ 1 h band. */
function hhmm(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h ${pad2(m)}`;
}

/**
 * Format a signed time-to-target as the key countdown (§8, contract #1). One
 * rule keyed off `t = |msRemaining|`, applied to every caller (to-start
 * countdown, overdue count-up, and the in-call count-down-to-end):
 *
 * - `t ≤ 5 min` → `MM:SS` / `+MM:SS` — the only band that shows seconds.
 * - `5 min < t < 1 h` → `42m` / `+42m` — bare floored minute count (`m` suffix,
 *   unmistakably not seconds); floor so no minute is skipped and the band tops
 *   out at `59m`, never a bogus `60m`.
 * - `t ≥ 1 h` → `1h 30` / `+1h 30`.
 *
 * In the seconds band, remaining rounds **up** so the key reads `00:01` through
 * the final second and hits `00:00` exactly at target; elapsed rounds **down**
 * so it begins at `+00:00`.
 *
 * @param msRemaining  `target - now` in ms (negative once the target is past).
 */
export function formatCountdown(msRemaining: number): string {
  const sign = msRemaining < 0 ? "+" : "";
  const t = Math.abs(msRemaining);
  // Remaining counts down (ceil to the whole second still ahead); elapsed counts
  // up (floor to the whole second already past).
  const sec = sign ? Math.floor(t / 1000) : Math.ceil(t / 1000);

  if (t <= SECONDS_WINDOW_MS) {
    return `${sign}${mmss(sec)}`;
  }
  if (t >= HOUR_MS) {
    return `${sign}${hhmm(sec)}`;
  }
  return `${sign}${Math.floor(t / 60000)}m`;
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
