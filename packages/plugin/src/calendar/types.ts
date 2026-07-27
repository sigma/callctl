/**
 * Types for the plugin-side calendar engine (§2). This file is UI-agnostic and
 * carries no Stream Deck or network imports so it can be unit-tested in a plain
 * node context.
 */

/**
 * A single node-ical property value. node-ical returns most properties as bare
 * strings, but a **parametrized** property (one that carried e.g. `FMTTYPE`,
 * such as `X-ALT-DESC;FMTTYPE=text/html`) comes back as `{ params, val }` — the
 * unfolded value lives under `.val` (§6.1). Repeated properties may arrive as an
 * array; readers take the first element.
 */
export type IcalProperty =
  | string
  | { params?: Record<string, unknown>; val?: string }
  | Array<string | { params?: Record<string, unknown>; val?: string }>
  | undefined;

/**
 * The structural shape of a parsed node-ical `VEVENT` — only the properties the
 * §6.1 extraction precedence reads. node-ical **de-prefixes** `X-` keys, so
 * `X-GOOGLE-CONFERENCE` is read as `GOOGLE-CONFERENCE` and `X-ALT-DESC` as
 * `ALT-DESC`. Typed loosely (any node-ical VEvent satisfies it) so this module
 * need not depend on node-ical; the engine (#57) passes real VEvents through.
 */
export interface ParsedEvent {
  "GOOGLE-CONFERENCE"?: IcalProperty;
  location?: IcalProperty;
  description?: IcalProperty;
  "ALT-DESC"?: IcalProperty;
  url?: IcalProperty;
  // node-ical events carry many more fields (start, end, uid, …) — ignored here.
  [key: string]: unknown;
}

/** The providers the extractor can canonicalize (§6.2). */
export type JoinProvider = "gmeet" | "zoom" | "teams";

/**
 * The tiered, canonicalized result of extraction (§6.3). The extractor **never**
 * returns a raw URL: a recognized provider is reconstructed from a hard-coded
 * template (tier a); anything else that still looks like a meeting is a bare
 * tier-b marker (the opener supplies a feed-derived fallback URL); a non-meeting
 * event yields `null` (tier c) and is dropped from selection.
 */
export type JoinCandidate =
  | {
      tier: "a";
      provider: JoinProvider;
      /**
       * Provider-namespaced join token — e.g. `gmeet:abc-def-ghi`,
       * `zoom:1234567890`. This is the *same* token used for join-detection
       * (§10). Absent for Teams, whose join token is opaque.
       */
      code?: string;
      /** Reconstructed / allowlisted URL — safe to open. Never the raw value. */
      joinUrl: string;
    }
  | { tier: "b" };

/**
 * One selected, still-relevant, link-bearing event instance (§5). The engine
 * expands recurrences over a bounded horizon, drops instances with no join
 * candidate (tier c), keeps those whose {@link end} is still in the future, and
 * returns them ordered `start ↑ → end ↑ → uid`. A key selects one by its
 * `offset` index into that list.
 */
export interface MeetingInstance {
  /** Absolute start instant of this occurrence. */
  start: Date;
  /** Real `DTEND`, or `start + 30 min` synthesized when `DTEND` is absent (§5). */
  end: Date;
  /** `true` for a date-only (all-day) event. */
  allDay: boolean;
  /** Event `SUMMARY`, unwrapped to a plain string ("" if absent). */
  title: string;
  /** The `id` of the {@link NamedFeed} this instance came from (§3). */
  sourceFeedId: string;
  /** The §6 join candidate — always tier (a) or (b); tier (c) is dropped. */
  candidate: JoinCandidate;
}

/**
 * Freshness of a feed's cached event set (§9), driving the face selection in §8:
 * - `loading` — no successful poll yet and no failure yet (cold start in flight).
 * - `ok` — a usable cache exists; render off it (even if the *last* poll failed,
 *   §9 "failure with a usable cache → keep rendering, no visible change").
 * - `cold-error` — a poll failed and there is **no** cache to fall back on →
 *   the dedicated cold-start error face (§8).
 */
export type FeedStatus = "loading" | "ok" | "cold-error";

/** A snapshot of one feed's cached selection + freshness, read by the render clock. */
export interface FeedSnapshot {
  /** The ordered link-bearing instances from the last successful poll ([] until then). */
  list: MeetingInstance[];
  status: FeedStatus;
}

/**
 * The display horizon of a single key (§5). Given the ordered list, the key's
 * `offset`, and its configurable countdown horizon, classifies what the key
 * should show — the action (#58) maps this to a live countdown or a "Free" face.
 * The horizon is a **duration** ("within N minutes of start"), not a calendar
 * day, so a meeting straddling local midnight is classified by how soon it is,
 * not which date it falls on.
 */
export type DisplayHorizon =
  /** The key's event starts **within** the horizon → live countdown. */
  | { kind: "within"; instance: MeetingInstance }
  /** The key's event starts **beyond** the horizon → "Free" + a next-meeting hint. */
  | { kind: "beyond"; instance: MeetingInstance }
  /** No event at this `offset` → plain "Free" / "No meetings". */
  | { kind: "none" };
