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

import { type IdentitySource, resolveIdentityWithSource } from "./attendance.js";
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
 * Which addresses counted as "me" for this test, and where they came from (§5.1)
 * — the `[Test]` report is the **only** surface for the identity, so it has to
 * say enough to diagnose a typo'd or stale one.
 *
 * The `addresses` are always the **canonical** form a poll compares with, so
 * `Me@Example.com ` reads back as `me@example.com` and a stray character is
 * visible. `none` means the declined half of the verdict is a no-op for this
 * feed — a fully functional feed, not an error. `"unknown"` is the one source
 * this wire type adds to §5.1's three-rung ladder: the server answered `304`, so
 * there was no body to infer from and we decline to *report* a `none` we never
 * actually looked for.
 *
 * Addresses are **not** secrets (unlike the feed URL, §12): the user typed them
 * one field away, and hiding them would defeat the point of the report.
 */
export interface TestFeedIdentity {
  source: IdentitySource | "unknown";
  addresses: string[];
}

/**
 * The verdict of one `[Test]` (§11). Never carries the URL. On success it reports
 * the total `VEVENT` count (`events`), how many of those yield a join link
 * (`joinable`, §6 tiers a/b), the next joinable instance (`next`, `null` when
 * none is upcoming), and the §5.1 `identity` in effect. On failure it names a
 * specific reason the PI can explain ("401", "not a calendar", "timed out", …);
 * `status` rides an HTTP failure.
 */
export type TestFeedResult =
  | {
      ok: true;
      events: number;
      joinable: number;
      next: TestFeedNext | null;
      identity: TestFeedIdentity;
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
  /**
   * The candidate feed's configured `identities` (§3) — the *unsaved* editor
   * value, so a Test reports what the address the user is currently typing would
   * do. Absent/blank ⇒ the §5.1 inference, exactly as a real poll.
   */
  identities?: readonly string[];
}

/**
 * Fetch + parse a candidate feed once and report a {@link TestFeedResult} (§11).
 *
 * Deliberately sends **no** conditional-GET validators, so a reachable server
 * always returns a full `200` body to count — a Test wants ground truth, not the
 * cache-reuse path. Fetch/HTTP failures map straight from {@link fetchFeed}'s
 * typed reasons; a body that `node-ical` cannot parse is reported as
 * `not-a-calendar` (the URL resolved but did not serve iCal). Never throws.
 *
 * A success verdict also reports the §5.1 `identity` in effect, resolved from
 * `opts.identities` + the fetched body exactly as a poll would.
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
    // No body ⇒ nothing to infer from. A configured list still stands on its own;
    // without one the honest answer is "unknown", not "none".
    const resolved = resolveIdentityWithSource(opts.identities, null);
    return {
      ok: true,
      events: 0,
      joinable: 0,
      next: null,
      identity: resolved.source === "none" ? { source: "unknown", addresses: [] } : resolved,
    };
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
  // Resolve once and reuse: the reported identity is *by construction* the one
  // selection ran with, so the report can never describe a different rule than
  // the one applied.
  const identity = resolveIdentityWithSource(opts.identities, parsed);
  const list = selectMeetings(parsed, "__test__", now, identity.addresses);
  const head = list[0];
  return {
    ok: true,
    events,
    joinable: list.length,
    next: head ? { title: head.title, startMs: head.start.getTime() } : null,
    identity,
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

  // `identities` is optional, but a *present* one that isn't a string list is a
  // malformed message, not an empty one: rejecting outright beats silently
  // testing with no identity and reporting a `none` the user never asked for.
  const rawIdentities = (payload as { identities?: unknown }).identities;
  let identities: string[] | undefined;
  if (rawIdentities !== undefined) {
    if (!Array.isArray(rawIdentities) || rawIdentities.some((s) => typeof s !== "string")) {
      return null;
    }
    identities = rawIdentities as string[];
  }

  const result = await testFeed(url, { ...opts, identities });
  return {
    command: "testResult",
    requestId: typeof requestId === "string" ? requestId : "",
    result,
  };
}
