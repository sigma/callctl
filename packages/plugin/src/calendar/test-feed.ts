/**
 * The Property Inspector's `[Test]` button (§11) — a **one-shot** fetch → parse →
 * select against a candidate feed URL, reusing the §4–§5 engine (no caching, no
 * conditional-GET validators: a Test always wants a live full body). It reports
 * back a small, typed verdict the PI renders: reachable? how many events parsed?
 * what's the next joinable one — or a specific failure reason.
 *
 * Like the rest of `src/calendar/`, this is UI-agnostic and `fetch`-injectable so
 * it is vitest-testable with no network. The candidate URL is a **capability
 * secret** (§12): it never appears in the returned verdict and is never logged.
 */

import { parseFeed, selectMeetings } from "./engine.js";
import { fetchFeed } from "./fetch.js";

/** The single upcoming joinable event surfaced by a successful test (§11 "next joinable"). */
export interface TestFeedNext {
  /** Event `SUMMARY` ("" if the event has none). */
  title: string;
  /** Absolute start instant as epoch ms — the PI formats it in machine-local tz. */
  startMs: number;
}

/**
 * The verdict of one `[Test]` (§11). Never carries the URL. On success it reports
 * the total `VEVENT` count (`events`), how many of those yield a join link
 * (`joinable`, §6 tiers a/b), and the next joinable instance (`next`, `null` when
 * none is upcoming). On failure it names a specific reason the PI can explain
 * ("401", "not a calendar", "timed out", …); `status` rides an HTTP failure.
 */
export type TestFeedResult =
  | {
      ok: true;
      events: number;
      joinable: number;
      next: TestFeedNext | null;
    }
  | { ok: false; error: "scheme" | "timeout" | "network" | "not-a-calendar" }
  | { ok: false; error: "http"; status: number };

export interface TestFeedOptions {
  /** Injectable `fetch` — defaults to the global; tests supply a fake (no network). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms; forwarded to {@link fetchFeed}. */
  timeoutMs?: number;
  /** Reference instant for selection (injected for deterministic tests; defaults to now). */
  now?: Date;
}

/**
 * Fetch + parse a candidate feed once and report a {@link TestFeedResult} (§11).
 *
 * Deliberately sends **no** conditional-GET validators, so a reachable server
 * always returns a full `200` body to count — a Test wants ground truth, not the
 * cache-reuse path. Fetch/HTTP failures map straight from {@link fetchFeed}'s
 * typed reasons; a body that `node-ical` cannot parse is reported as
 * `not-a-calendar` (the URL resolved but did not serve iCal). Never throws.
 */
export async function testFeed(url: string, opts: TestFeedOptions = {}): Promise<TestFeedResult> {
  const res = await fetchFeed(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });

  if (res.kind === "error") {
    // An HTTP failure always carries a status (§4); the others never do.
    if (res.reason === "http") return { ok: false, error: "http", status: res.status ?? 0 };
    return { ok: false, error: res.reason };
  }

  // No validators were sent, so a well-behaved server cannot answer 304; if one
  // does anyway, we have no cached body to describe — treat it as reachable but
  // empty rather than inventing a count.
  if (res.kind === "not-modified") {
    return { ok: true, events: 0, joinable: 0, next: null };
  }

  let parsed: Awaited<ReturnType<typeof parseFeed>>;
  try {
    parsed = await parseFeed(res.text);
  } catch {
    return { ok: false, error: "not-a-calendar" };
  }

  // node-ical never throws on a non-iCal body — it returns an empty component
  // map. A genuine calendar (even one with zero events) always yields a
  // `VCALENDAR` component; its absence means the URL resolved but did not serve
  // iCal (an HTML error page, a JSON blob, …), which is the "not a calendar"
  // failure §11 wants to distinguish from an empty-but-valid feed.
  const components = Object.values(parsed);
  const isCalendar = components.some((c) => (c as { type?: string } | null)?.type === "VCALENDAR");
  if (!isCalendar) {
    return { ok: false, error: "not-a-calendar" };
  }

  const events = components.filter(
    (c) => (c as { type?: string } | null)?.type === "VEVENT",
  ).length;

  const now = opts.now ?? new Date();
  const list = selectMeetings(parsed, "__test__", now);
  const head = list[0];
  return {
    ok: true,
    events,
    joinable: list.length,
    next: head ? { title: head.title, startMs: head.start.getTime() } : null,
  };
}

/** The `testResult` reply the PI expects; matched to its row via `requestId`. */
export interface TestFeedReply {
  command: "testResult";
  requestId: string;
  result: TestFeedResult;
}

/**
 * Handle a raw Property-Inspector message (§11). Returns the `testResult` reply
 * for a well-formed `testFeed` request, or `null` for any other message (one we
 * don't own). The payload is untrusted JSON from the PI, so its shape is
 * validated before the network is touched; `requestId` is echoed back so the PI
 * can match the reply to the feed row that asked. The URL is never logged (§12).
 *
 * Kept here (not on {@link NextMeetingAction}) so the action stays free of the
 * SDK singleton and fully unit-testable; `plugin.ts` owns the thin UI wiring.
 */
export async function handlePiTestMessage(
  payload: unknown,
  opts: TestFeedOptions = {},
): Promise<TestFeedReply | null> {
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { command?: unknown }).command !== "testFeed"
  ) {
    return null;
  }
  const url = (payload as { url?: unknown }).url;
  if (typeof url !== "string") return null;
  const requestId = (payload as { requestId?: unknown }).requestId;

  const result = await testFeed(url, opts);
  return {
    command: "testResult",
    requestId: typeof requestId === "string" ? requestId : "",
    result,
  };
}
