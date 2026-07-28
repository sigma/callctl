/**
 * The pure "what should this key show" decision (§8 baseline, non-escalating).
 * Given the feed's cached selection, the key's offset, and `now`, it returns a
 * {@link KeyFace} — the render clock (§9) calls this every tick and hands the
 * result to the SVG renderer. No Stream Deck imports: fully vitest-testable.
 *
 * The **baseline** faces (#58) are the live countdown, the green "Free" (+
 * future-day hint), the unconfigured setup prompt, and the cold-start error.
 * This ticket (#59) layers the §8 **escalation** onto the countdown: the
 * per-threshold state (normal → approaching → imminent → late) and the render
 * clock's blink/flash phase, both derived purely from `now` vs. the event start.
 */

import { displayHorizon, joinIdentity } from "./engine.js";
import type { MeetingHint } from "./format.js";
import { formatCountdown, formatMeetingHint, SECONDS_WINDOW_MS } from "./format.js";
import type { FeedStatus, MeetingInstance } from "./types.js";

/**
 * The §8 escalation state of a live countdown, keyed off the time-to-start:
 * - `normal` — `> 5 min`, steady slate.
 * - `approaching` — `≤ 5 min`, steady orange.
 * - `imminent` — `≤ 30 s` (still before start), red with a gentle blink.
 * - `late` — past start but within `graceMinutes`, flashing red counting **up** `+MM:SS`.
 * - `overdue` — past `start + graceMinutes` and still never joined: the flash
 *   calms to a **steady** red (no blink), still counting **up** `+MM:SS`. The
 *   meeting is *not* dropped — it stays until its `DTEND` (§9).
 */
export type Escalation = "normal" | "approaching" | "imminent" | "late" | "overdue";

/** `≤ 5 min` to start → approaching (§8). */
const APPROACHING_MS = 5 * 60 * 1000;
/** `≤ 30 s` to start → imminent (§8). */
const IMMINENT_MS = 30 * 1000;
/** Imminent's gentle blink: ~1.2 s period → 600 ms half-cycle (§8). */
const IMMINENT_BLINK_HALF_MS = 600;
/** Late's hard flash: ~0.9 s period → 450 ms half-cycle (§8). */
const LATE_FLASH_HALF_MS = 450;

/**
 * Classify the §8 escalation from the signed ms-to-start (`start − now`), with
 * the flash calming to steady `overdue` once past `graceMs` (the §10 grace no
 * longer *dismisses*, it only ends the flashing).
 */
function escalationFor(msToStart: number, graceMs: number): Escalation {
  if (msToStart < -graceMs) return "overdue";
  if (msToStart < 0) return "late";
  if (msToStart <= IMMINENT_MS) return "imminent";
  if (msToStart <= APPROACHING_MS) return "approaching";
  return "normal";
}

/**
 * Whether the current render tick falls in the **off** half of the blink/flash
 * cycle (§8), computed purely from `now` so the 500 ms render clock samples it
 * without any per-key blink state. Only imminent (gentle) and late (hard) blink;
 * steady states never blink.
 */
function isBlinkOff(escalation: Escalation, now: Date): boolean {
  const half =
    escalation === "imminent"
      ? IMMINENT_BLINK_HALF_MS
      : escalation === "late"
        ? LATE_FLASH_HALF_MS
        : 0;
  if (half === 0) return false;
  return Math.floor(now.getTime() / half) % 2 === 1;
}

/** What the key should render (§8), independent of how it's drawn. */
export type KeyFace =
  /** Cold start in flight — no data yet, no error yet. */
  | { kind: "loading" }
  /** No `feedId`, or it points at a deleted feed → nudge to the Property Inspector. */
  | { kind: "unconfigured" }
  /** A poll failed and there is no cache to fall back on (§9) — distinct attention state. */
  | { kind: "error" }
  /** Between meetings; `hint` is the next-meeting signpost (date + time) or `null`. */
  | { kind: "free"; hint: MeetingHint | null }
  /**
   * You are **in this call** (§10 join-proof): the meeting stays surfaced until
   * its end instead of flashing late or advancing. `time` counts **down to the
   * meeting's end**; the renderer gives it a distinct field so it never reads as
   * the alarming late flash.
   */
  | { kind: "active"; title: string; time: string }
  /**
   * A live countdown to (or overdue count-up past) the key's event. `escalation`
   * picks the §8 colour/behaviour; `blinkOff` is `true` on the off half of the
   * blink (imminent) / flash (late) cycle for the current render tick.
   */
  | { kind: "countdown"; title: string; time: string; escalation: Escalation; blinkOff: boolean };

/** Inputs to {@link computeFace} — the key's resolved feed state at one instant. */
export interface FaceInput {
  /** `false` when the key's `feedId` is empty or dangles (no such feed) → unconfigured. */
  configured: boolean;
  /** Freshness of the feed's cache (§9). */
  status: FeedStatus;
  /** The feed's ordered link-bearing instances (§5). */
  list: MeetingInstance[];
  /** The key's index into {@link list} (§3). */
  offset: number;
  /** The reference instant (injected by the render clock; here for determinism/testing). */
  now: Date;
  /** The key's countdown horizon in ms (§3/§5; default 24h). */
  horizonMs: number;
  /** The key's late-state grace in ms (§3/§10): flash → steady `overdue` cutoff. */
  graceMs: number;
  /** {@link joinIdentity} strings of meetings joined this session (§10) — held in-call. */
  heldKeys: ReadonlySet<string>;
}

/**
 * Classify a key's baseline face (§8). Precedence: unconfigured beats every
 * data state (a key with no feed shows the setup prompt regardless of poll
 * status); a cold-start error beats loading; otherwise the configurable display
 * horizon (§5, "within `horizonMs` of start") decides countdown vs. Free.
 */
export function computeFace(input: FaceInput): KeyFace {
  const { configured, status, list, offset, now, horizonMs, graceMs, heldKeys } = input;

  if (!configured) return { kind: "unconfigured" };
  if (status === "cold-error") return { kind: "error" };
  if (status === "loading") return { kind: "loading" };

  const horizon = displayHorizon(list, offset, now, horizonMs);
  switch (horizon.kind) {
    case "within": {
      // Joined this session (§10): hold it as a calm in-progress countdown to its
      // end, never the late flash — you already dealt with it. Durable across
      // leaving the call (`heldKeys` remembers the occurrence).
      const id = joinIdentity(horizon.instance);
      if (id !== null && heldKeys.has(id)) {
        return {
          kind: "active",
          title: horizon.instance.title,
          time: formatCountdown(horizon.instance.end.getTime() - now.getTime()),
        };
      }
      const msToStart = horizon.instance.start.getTime() - now.getTime();
      const escalation = escalationFor(msToStart, graceMs);
      return {
        kind: "countdown",
        title: horizon.instance.title,
        time: formatCountdown(msToStart),
        escalation,
        blinkOff: isBlinkOff(escalation, now),
      };
    }
    case "beyond":
      return { kind: "free", hint: formatMeetingHint(horizon.instance.start) };
    case "none":
      return { kind: "free", hint: null };
  }
}

// ---- render clock: when does the face next change? (contract #2–#4) ---------

/** One hour in ms — the `Hh MM` ↔ `42m` band boundary (mirrors `format.ts`). */
const HOUR_MS = 60 * 60 * 1000;
/**
 * Backstop cap on any scheduled repaint (contract #2). A key whose face is static
 * (Free / unconfigured / error / loading) or whose next change we can't pin (a
 * poll that will land out of band) still repaints at least this often, so nothing
 * stalls. Never a *sampling* clock — animating faces schedule far tighter than
 * this — purely the ceiling.
 */
export const MAX_MS = 10_000;

/**
 * Ms until the next wall-clock blink edge for a `half`-ms half-period (contract
 * #3/#4). Strictly positive and `≤ half`: at `now` exactly on an edge it returns
 * a full `half` (the *next* edge), never `0`. Landing a repaint here makes the
 * blink phase `Math.floor(now / half) % 2` flip the instant we repaint, so the
 * flash can never alias — the guarantee that replaces the dropped 150 ms sampler.
 */
function nextBlinkEdge(nowMs: number, half: number): number {
  const past = nowMs % half;
  return past === 0 ? half : half - past;
}

/**
 * Ms until `formatCountdown`'s *within-band* glyph next changes, given the signed
 * `msRemaining` (`target − now`). Band **transitions** (seconds↔minute at
 * `±SECONDS_WINDOW_MS`, minute↔hour at `±HOUR_MS`) are handled by the boundary
 * terms in {@link msToNextVisibleChange}; this returns only the tick *inside* the
 * current band, exactly honoring `formatCountdown`'s rounding (ceil for a live
 * countdown, floor for an elapsed count-up).
 */
function msToNextCountdownGlyph(msRemaining: number): number {
  const t = Math.abs(msRemaining);
  const remaining = msRemaining > 0;
  if (t <= SECONDS_WINDOW_MS) {
    // Seconds band. Remaining: `ceil(r/1000)` — constant on `((v-1)·1000, v·1000]`,
    // so it flips the instant `r` reaches `(v-1)·1000`. Elapsed: `floor(t/1000)`.
    return remaining
      ? msRemaining - (Math.ceil(msRemaining / 1000) - 1) * 1000
      : floorEdge(t, 1000);
  }
  if (t < HOUR_MS) {
    // Minute band (`42m`): raw `floor(t/60000)` in both directions (contract #1).
    return remaining ? (msRemaining % 60000) + 1 : floorEdge(t, 60000);
  }
  // Hour band (`Hh MM`): displayed minute is `floor(sec/60)`, `sec` the same
  // ceil/floor of `r/1000` the seconds band uses — so it flips one second early
  // on a live countdown, exactly as `formatCountdown` does.
  if (remaining) {
    const sec = Math.ceil(msRemaining / 1000);
    return msRemaining - (60 * Math.floor(sec / 60) - 1) * 1000;
  }
  const sec = Math.floor(t / 1000);
  return (Math.floor(sec / 60) + 1) * 60000 - t;
}

/** Ms until a `floor(t/unit)` count-up increments (its `+MM:SS` / `+42m` glyph flips). */
function floorEdge(t: number, unit: number): number {
  const past = t % unit;
  return past === 0 ? unit : unit - past;
}

/**
 * The soonest instant (ms from `now`, at most {@link MAX_MS}) at which this key's
 * face — as {@link computeFace} would draw it — next changes. The render clock
 * schedules exactly one repaint per key at this delay, so a key repaints *only*
 * when its face actually moves (contract #2): every countdown tick, escalation
 * step, blink edge, and meeting boundary, and nothing in between.
 *
 * The value is the minimum over the change sources the current face is subject to:
 * - **countdown glyph** — the next second/minute/hour tick ({@link msToNextCountdownGlyph}).
 * - **blink edge** — for an `imminent`/`late` countdown ({@link nextBlinkEdge}).
 * - **tier / escalation boundaries** — the signed-time thresholds where the band
 *   or escalation flips: `±SECONDS_WINDOW_MS`, the 30 s imminent mark, `start`
 *   (imminent→late), `start + grace` (late→overdue, flash → steady), `±HOUR_MS`.
 *   Each is scheduled *on* the boundary, never past it (no overshoot).
 * - **meeting boundary** — the soonest `DTEND` among the still-current instances
 *   up to this key's offset (any of them ending re-indexes the view), and the
 *   `beyond → within` horizon crossing.
 *
 * Static faces (Free / unconfigured / error / loading) have no intrinsic change
 * and fall through to {@link MAX_MS}; a landing poll repaints them out of band.
 * Pure and total — same inputs as {@link computeFace}, no side effects.
 */
export function msToNextVisibleChange(input: FaceInput): number {
  const { configured, status, list, offset, now, horizonMs, graceMs, heldKeys } = input;
  const nowMs = now.getTime();

  if (!configured || status === "cold-error" || status === "loading") return MAX_MS;

  const horizon = displayHorizon(list, offset, now, horizonMs);
  if (horizon.kind === "none") return MAX_MS;

  const candidates: number[] = [MAX_MS];

  // Meeting boundary: any still-current instance at index ≤ offset ending re-indexes
  // the view (the offset-th surfaced meeting shifts), so schedule on the soonest.
  const stillCurrent = list.filter((i) => i.end.getTime() > nowMs);
  for (let i = 0; i <= offset && i < stillCurrent.length; i++) {
    candidates.push(stillCurrent[i].end.getTime() - nowMs);
  }

  if (horizon.kind === "beyond") {
    // Free + hint until the event enters the horizon (`start − now` drops below it).
    const cross = horizon.instance.start.getTime() - horizonMs - nowMs;
    if (cross > 0) candidates.push(cross);
    return clampDelay(candidates);
  }

  const inst = horizon.instance;
  const id = joinIdentity(inst);
  if (id !== null && heldKeys.has(id)) {
    // Held (in-call): a calm countdown to the meeting's end — no escalation, no blink.
    const r = inst.end.getTime() - nowMs;
    candidates.push(msToNextCountdownGlyph(r));
    pushBoundaries(candidates, r, [SECONDS_WINDOW_MS, HOUR_MS]);
    return clampDelay(candidates);
  }

  // Countdown to (or overdue count-up past) the event start.
  const r = inst.start.getTime() - nowMs;
  candidates.push(msToNextCountdownGlyph(r));
  // Signed thresholds where the band or escalation flips; `APPROACHING_MS` and
  // `SECONDS_WINDOW_MS` coincide, so the ±window term covers both.
  pushBoundaries(candidates, r, [
    SECONDS_WINDOW_MS,
    IMMINENT_MS,
    0,
    -graceMs,
    -SECONDS_WINDOW_MS,
    HOUR_MS,
    -HOUR_MS,
  ]);
  const escalation = escalationFor(r, graceMs);
  if (escalation === "imminent" || escalation === "late") {
    candidates.push(
      nextBlinkEdge(nowMs, escalation === "imminent" ? IMMINENT_BLINK_HALF_MS : LATE_FLASH_HALF_MS),
    );
  }
  return clampDelay(candidates);
}

/**
 * Add each signed threshold `b` the value `r` is still *above* as a delay `r − b`:
 * the instant `r` (decreasing at 1 ms/ms as `now` advances) reaches the boundary.
 * Gating on `r > b` schedules the repaint *on* the boundary, never past it.
 */
function pushBoundaries(candidates: number[], r: number, boundaries: number[]): void {
  for (const b of boundaries) {
    if (r > b) candidates.push(r - b);
  }
}

/** Clamp a delay set to `[1, MAX_MS]` — strictly positive so a timer never busy-loops. */
function clampDelay(candidates: number[]): number {
  return Math.max(1, Math.min(...candidates));
}
