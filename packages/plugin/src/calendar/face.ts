/**
 * The pure "what should this key show" decision (§8 baseline, non-escalating).
 * Given the feed's cached selection, the key's offset, and `now`, it returns a
 * {@link KeyFace} — the render clock (§9) calls this every tick and hands the
 * result to the SVG renderer. No Stream Deck imports: fully vitest-testable.
 *
 * This ticket (#58) covers only the **baseline** faces: the live countdown, the
 * green "Free" (+ future-day hint), the unconfigured setup prompt, and the
 * cold-start error. Escalation colours, blink/flash, the late count-up dismissal
 * and boundary advance are #59 — they layer on top of `countdown` later.
 */

import { displayHorizon } from "./engine.js";
import { formatCountdown, formatDayHint } from "./format.js";
import type { FeedStatus, MeetingInstance } from "./types.js";

/** What the key should render (§8), independent of how it's drawn. */
export type KeyFace =
  /** Cold start in flight — no data yet, no error yet. */
  | { kind: "loading" }
  /** No `feedId`, or it points at a deleted feed → nudge to the Property Inspector. */
  | { kind: "unconfigured" }
  /** A poll failed and there is no cache to fall back on (§9) — distinct attention state. */
  | { kind: "error" }
  /** Between meetings; `hint` is the next-meeting signpost (future day) or `null`. */
  | { kind: "free"; hint: string | null }
  /** A live countdown to (or overdue count-up past) the key's event. */
  | { kind: "countdown"; title: string; time: string; overdue: boolean };

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
}

/**
 * Classify a key's baseline face (§8). Precedence: unconfigured beats every
 * data state (a key with no feed shows the setup prompt regardless of poll
 * status); a cold-start error beats loading; otherwise the today-only display
 * horizon (§5) decides countdown vs. Free.
 */
export function computeFace(input: FaceInput): KeyFace {
  const { configured, status, list, offset, now } = input;

  if (!configured) return { kind: "unconfigured" };
  if (status === "cold-error") return { kind: "error" };
  if (status === "loading") return { kind: "loading" };

  const horizon = displayHorizon(list, offset, now);
  switch (horizon.kind) {
    case "today":
      return {
        kind: "countdown",
        title: horizon.instance.title,
        time: formatCountdown(horizon.instance.start.getTime() - now.getTime()),
        overdue: horizon.instance.start.getTime() <= now.getTime(),
      };
    case "future":
      return { kind: "free", hint: formatDayHint(horizon.instance.start) };
    case "none":
      return { kind: "free", hint: null };
  }
}
