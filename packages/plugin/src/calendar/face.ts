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
import { formatCountdown, formatMeetingHint } from "./format.js";
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
