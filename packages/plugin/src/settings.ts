/**
 * The Next-Meeting settings schema (§3) — the single source of truth for what
 * the Property Inspector (a later ticket) reads/writes and what the action
 * consumes. Kept UI-agnostic (no Stream Deck imports) so the parse/resolve
 * helpers stay vitest-testable.
 *
 * For v1 the global feed list is **seeded manually as JSON global settings**;
 * the Property Inspector arrives in #60. Every value that reaches us from the
 * Stream Deck settings store is therefore untrusted/partial — the `parse*`
 * helpers coerce and default defensively rather than trusting the shape.
 */

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
  /** Late-state dismissal grace in minutes (§10); default 10. Consumed in #59/#62. */
  graceMinutes: number;
}

/** Default feed-poll cadence (§9). */
export const DEFAULT_POLL_INTERVAL_MINUTES = 15;
/** Default per-key list offset (§5). */
export const DEFAULT_OFFSET = 0;
/** Default late-state grace (§10). */
export const DEFAULT_GRACE_MINUTES = 10;

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
 * defaults. A fresh key has `{}` settings → `{ feedId: "", offset: 0,
 * graceMinutes: 10 }` (unconfigured).
 */
export function parseKeySettings(raw: unknown): NextMeetingSettings {
  const rec = isRecord(raw) ? raw : {};
  const offset = Math.trunc(num(rec.offset, DEFAULT_OFFSET));
  const grace = num(rec.graceMinutes, DEFAULT_GRACE_MINUTES);
  return {
    feedId: str(rec.feedId),
    offset: offset >= 0 ? offset : DEFAULT_OFFSET,
    graceMinutes: grace >= 0 ? grace : DEFAULT_GRACE_MINUTES,
  };
}

/** Resolve a key's `feedId` against the global feed list (§3). `undefined` ⇒ unconfigured/dangling. */
export function resolveFeed(global: GlobalSettings, feedId: string): NamedFeed | undefined {
  if (feedId === "") return undefined;
  return global.feeds.find((f) => f.id === feedId);
}
