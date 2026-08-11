/**
 * The Next-Meeting settings schema (§3) — the single source of truth for what
 * the Property Inspector (a later ticket) reads/writes and what the action
 * consumes. Kept UI-agnostic (no Stream Deck imports) so the parse/resolve
 * helpers stay vitest-testable.
 *
 * The Property Inspector (§11, #60) reads/writes these shapes over the Stream
 * Deck settings store. Every value that reaches us from that store is still
 * untrusted/partial (a hand-seeded blob, an older PI, a deleted feed) — the
 * `parse*` helpers coerce and default defensively rather than trusting the shape.
 */

import { isPaletteToken, type PaletteToken } from "./calendar/palette.js";

/** Chromium-family browser a feed can target for profile-specific opens (§3, #51). */
export type BrowserId = "chrome" | "chromium" | "edge" | "brave";

/** A globally-registered secret iCal feed (§3). */
export interface NamedFeed {
  /** Stable generated slug/uuid — survives renames so per-key `feedId` refs don't break. */
  id: string;
  /** Human label shown in the per-key dropdown. */
  name: string;
  /** Secret capability URL, stored PLAINTEXT in global settings only (§12). Never logged. */
  url: string;
  /** Optional per-feed browser-profile targeting (#51); consumed by the tier-2 opener in #61. */
  open?: {
    browser: BrowserId;
    /** Literal `--profile-directory` folder name, e.g. `"Profile 1"`. */
    profile: string;
  };
  /**
   * Optional per-feed border color, one of the 10 palette tokens (#78). Absent ⇒
   * no border (today's exact look). Stored as a token, never raw hex, so the
   * palette can be re-tuned without migrating settings; resolved to hex by
   * {@link resolvePaletteColor} at render time.
   */
  color?: PaletteToken;
  /**
   * Optional addresses that count as **you** on this feed, for the §5.1 declined
   * rule (#90). Per-feed, never global — a feed *is* an account, so one global
   * identity would silently match nobody the moment a second account's feed is
   * added. A `string[]` because aliases are real (an invite to an alias lands on
   * the same calendar with the alias as `ATTENDEE`). Absent/empty ⇒ the §5.1
   * `X-WR-CALNAME` inference, then a pure no-op.
   */
  identities?: string[];
}

/** Plugin-wide settings (§3). */
export interface GlobalSettings {
  feeds: NamedFeed[];
  /** Feed-poll cadence in minutes (§9). */
  pollIntervalMinutes: number;
}

/** Per-key action settings (§3). */
export interface NextMeetingSettings {
  /** Which global feed this key tracks; empty or dangling ⇒ unconfigured (§8). */
  feedId: string;
  /** Index into the ordered event list (§5); default 0. */
  offset: number;
  /**
   * Countdown horizon in minutes (§5): an event whose start is **less than** this
   * far in the future gets the live countdown face; anything further off shows as
   * "Free" + a day hint. Replaces the old today-only (same-local-day) horizon,
   * which misclassified meetings straddling local midnight. Default 24h
   * ({@link DEFAULT_HORIZON_MINUTES}).
   */
  horizonMinutes: number;
}

/** Default feed-poll cadence (§9). */
export const DEFAULT_POLL_INTERVAL_MINUTES = 15;
/** Default per-key list offset (§5). */
export const DEFAULT_OFFSET = 0;
/** Default countdown horizon (§5): 24h. */
export const DEFAULT_HORIZON_MINUTES = 24 * 60;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Read a finite number, else the fallback. */
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Read a plain string, else `""`. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseFeed(raw: unknown): NamedFeed | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const url = str(raw.url);
  // A feed with no id or no url can never be referenced/fetched — drop it.
  if (id === "" || url === "") return undefined;
  const feed: NamedFeed = { id, name: str(raw.name), url };
  // Border color: keep only a known palette token; an absent, empty, or unknown
  // value leaves `color` off (⇒ no border), never trusting the stored shape.
  if (isPaletteToken(raw.color)) feed.color = raw.color;
  // Identities (§3): keep only non-empty trimmed strings. A non-array, or an
  // array that leaves nothing after filtering, omits the field entirely — an
  // empty list and an absent one mean the same thing (fall through to §5.1's
  // inference), so storing `[]` would only be a second way to say "unset".
  if (Array.isArray(raw.identities)) {
    const identities = raw.identities
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (identities.length > 0) feed.identities = identities;
  }
  if (isRecord(raw.open)) {
    const browser = raw.open.browser;
    const profile = str(raw.open.profile);
    if (
      (browser === "chrome" ||
        browser === "chromium" ||
        browser === "edge" ||
        browser === "brave") &&
      profile !== ""
    ) {
      feed.open = { browser, profile };
    }
  }
  return feed;
}

/**
 * Coerce raw (untrusted, possibly hand-seeded) global settings into a
 * {@link GlobalSettings}. Malformed feeds are dropped; a non-positive or missing
 * poll interval falls back to {@link DEFAULT_POLL_INTERVAL_MINUTES}.
 */
export function parseGlobalSettings(raw: unknown): GlobalSettings {
  const rec = isRecord(raw) ? raw : {};
  const feeds = Array.isArray(rec.feeds)
    ? rec.feeds.map(parseFeed).filter((f): f is NamedFeed => f !== undefined)
    : [];
  const poll = num(rec.pollIntervalMinutes, DEFAULT_POLL_INTERVAL_MINUTES);
  return {
    feeds,
    pollIntervalMinutes: poll > 0 ? poll : DEFAULT_POLL_INTERVAL_MINUTES,
  };
}

/**
 * Coerce raw per-key settings into a {@link NextMeetingSettings}, applying
 * defaults. A fresh key has `{}` settings → `{ feedId: "", offset: 0 }`
 * (unconfigured).
 */
export function parseKeySettings(raw: unknown): NextMeetingSettings {
  const rec = isRecord(raw) ? raw : {};
  const offset = Math.trunc(num(rec.offset, DEFAULT_OFFSET));
  const horizon = num(rec.horizonMinutes, DEFAULT_HORIZON_MINUTES);
  return {
    feedId: str(rec.feedId),
    offset: offset >= 0 ? offset : DEFAULT_OFFSET,
    // A non-positive horizon would never surface a countdown — fall back rather
    // than let the key sit on "Free" forever.
    horizonMinutes: horizon > 0 ? horizon : DEFAULT_HORIZON_MINUTES,
  };
}

/** Resolve a key's `feedId` against the global feed list (§3). `undefined` ⇒ unconfigured/dangling. */
export function resolveFeed(global: GlobalSettings, feedId: string): NamedFeed | undefined {
  if (feedId === "") return undefined;
  return global.feeds.find((f) => f.id === feedId);
}
