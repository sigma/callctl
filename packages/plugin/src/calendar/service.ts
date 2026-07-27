/**
 * The feed-poll half of the two-clock model (§9): the UI-agnostic engine that
 * owns each feed's cached, ordered event set and its freshness. No timers, no
 * Stream Deck imports — the action drives the cadence and calls {@link
 * CalendarService.poll}; here we only do one conditional GET → parse → select
 * and swap the cache. `fetch` is injectable so this is vitest-testable with no
 * network (mirrors the `fetchFeed` test seam).
 *
 * The render clock never enters this file; it reads {@link
 * CalendarService.snapshot} and formats off the cache, so a failed poll never
 * freezes the countdown (§9).
 */

import type { GlobalSettings } from "../settings.js";
import { parseFeed, selectMeetings } from "./engine.js";
import { calendarFallbackUrl, type FeedValidators, fetchFeed } from "./fetch.js";
import type { FeedSnapshot, FeedStatus, MeetingInstance } from "./types.js";

/** Per-poll options, forwarded to {@link fetchFeed}; the fake `fetch` rides here in tests. */
export interface PollOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One feed's mutable cache: the last-parsed ordered instances, the conditional-GET
 * validators, and a {@link FeedStatus}. A single poll reconciles all three (§4, §9).
 */
class FeedCache {
  readonly feedId: string;
  #url: string;
  #validators: FeedValidators | undefined;
  #list: MeetingInstance[] = [];
  #status: FeedStatus = "loading";
  /** `true` once a poll has successfully parsed a body — gates cold-error vs. keep-stale (§9). */
  #everLoaded = false;
  /** In-flight poll, so two keys sharing a feed don't double-fetch / race the conditional GET. */
  #inflight: Promise<void> | undefined;

  constructor(feedId: string, url: string) {
    this.feedId = feedId;
    this.#url = url;
  }

  /**
   * Point this cache at a (possibly new) URL. A **changed** URL invalidates
   * everything — different secret ⇒ different calendar — so validators and cache
   * are dropped and the feed returns to cold-start (`loading`), which forces a
   * full re-fetch and, on failure, the cold-start error face (§8/§9).
   */
  setUrl(url: string): void {
    if (url === this.#url) return;
    this.#url = url;
    this.#validators = undefined;
    this.#list = [];
    this.#status = "loading";
    this.#everLoaded = false;
  }

  snapshot(): FeedSnapshot {
    return { list: this.#list, status: this.#status };
  }

  /** This feed's secret URL — read only to derive the tier-(b) origin (§6.4). */
  get url(): string {
    return this.#url;
  }

  poll(now: Date, opts: PollOptions): Promise<void> {
    // Coalesce concurrent polls of the same feed onto one request.
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#poll(now, opts).finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #poll(now: Date, opts: PollOptions): Promise<void> {
    const res = await fetchFeed(this.#url, {
      validators: this.#validators,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });

    switch (res.kind) {
      case "modified": {
        try {
          const parsed = await parseFeed(res.text);
          this.#list = selectMeetings(parsed, this.feedId, now);
          this.#validators = res.validators;
          this.#status = "ok";
          this.#everLoaded = true;
        } catch {
          // A parse failure is a poll failure (§9) — never a crash. Never log the body/URL.
          this.#status = this.#everLoaded ? "ok" : "cold-error";
        }
        break;
      }
      case "not-modified":
        // Server says our cache is current: reuse it, don't re-parse (§4).
        this.#status = "ok";
        this.#everLoaded = true;
        break;
      case "error":
        // With a usable cache, keep counting off it (no visible change, §9);
        // cold start with no cache → the dedicated error face.
        this.#status = this.#everLoaded ? "ok" : "cold-error";
        break;
    }
  }
}

/**
 * The registry of feed caches, reconciled from {@link GlobalSettings.feeds}. One
 * instance is shared across every Next-Meeting key (created in `plugin.ts`), so
 * two keys on the same feed share a single cache and a single poll (§9 "two
 * buttons per calendar re-index the same list").
 */
export class CalendarService {
  #feeds = new Map<string, FeedCache>();
  #pollIntervalMinutes: number;
  readonly #defaultFetch: typeof fetch | undefined;

  constructor(opts: { fetchImpl?: typeof fetch; pollIntervalMinutes?: number } = {}) {
    this.#defaultFetch = opts.fetchImpl;
    this.#pollIntervalMinutes = opts.pollIntervalMinutes ?? 15;
  }

  /** Current feed-poll cadence (§9); the action re-reads this each poll cycle. */
  get pollIntervalMinutes(): number {
    return this.#pollIntervalMinutes;
  }

  /**
   * Reconcile the cache registry against parsed global settings (§3): add caches
   * for new feeds, re-point (and thus invalidate) changed URLs, and drop caches
   * whose feed was removed. Updates the poll cadence. Does **not** fetch —
   * callers force a poll afterwards for immediate effect.
   */
  configure(global: GlobalSettings): void {
    this.#pollIntervalMinutes = global.pollIntervalMinutes;
    const seen = new Set<string>();
    for (const feed of global.feeds) {
      seen.add(feed.id);
      const existing = this.#feeds.get(feed.id);
      if (existing) existing.setUrl(feed.url);
      else this.#feeds.set(feed.id, new FeedCache(feed.id, feed.url));
    }
    for (const id of this.#feeds.keys()) {
      if (!seen.has(id)) this.#feeds.delete(id);
    }
  }

  /** All configured feed ids (used to poll every active feed). */
  feedIds(): string[] {
    return [...this.#feeds.keys()];
  }

  /**
   * Snapshot a feed's cache. `undefined` ⇒ **no such feed** (empty or dangling
   * `feedId`), which the action maps to the unconfigured face (§8).
   */
  snapshot(feedId: string): FeedSnapshot | undefined {
    return this.#feeds.get(feedId)?.snapshot();
  }

  /**
   * The tier-(b) feed-derived calendar fallback URL for a feed (§6.4) — the
   * feed's own origin, safe to open (the secret path never leaves this class).
   * `undefined` for an unknown feed or an unparseable URL, which the opener
   * treats as "nothing safe to open" (§7).
   */
  calendarFallback(feedId: string): string | undefined {
    const url = this.#feeds.get(feedId)?.url;
    return url === undefined ? undefined : calendarFallbackUrl(url);
  }

  /** Force one conditional-GET poll of a single feed. No-op for an unknown feed. */
  async poll(feedId: string, now: Date): Promise<void> {
    await this.#feeds.get(feedId)?.poll(now, { fetchImpl: this.#defaultFetch });
  }

  /** Force a poll of every configured feed (startup / config-change refresh, §9). */
  async pollAll(now: Date): Promise<void> {
    await Promise.all(
      [...this.#feeds.values()].map((f) => f.poll(now, { fetchImpl: this.#defaultFetch })),
    );
  }
}
