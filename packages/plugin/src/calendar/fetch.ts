/**
 * iCal fetch (§4) — hand-rolled conditional-GET HTTP so we own caching,
 * scheme rewriting, timeouts, and **secret handling**. Deliberately *not*
 * `node-ical`'s `fromURL`, which offers none of that control.
 *
 * The feed URL is a **capability URL**: the secret is in the path, so it must
 * **never be logged** — not on success, not on error. This module never logs
 * and never embeds the URL in a returned value or thrown message; failures come
 * back as a typed {@link FeedFetchResult} carrying only a reason (and, for HTTP
 * errors, the status code). Callers own their own logging and must keep the URL
 * out of it (§12).
 */

/** Default per-request timeout. A slow feed is a poll failure, never a hang (§4, §9). */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The freshness validators persisted per feed between polls (§4 "Conditional
 * GET"). Sent back as `If-None-Match` / `If-Modified-Since` on the next poll.
 */
export interface FeedValidators {
  /** Last seen `ETag` response header. Preferred when the server offers both. */
  etag?: string;
  /** Last seen `Last-Modified` response header. */
  lastModified?: string;
}

/** Why a fetch did not yield a fresh body — all handled as poll failures (§9). */
export type FeedFetchError =
  /** URL scheme was not `http(s)` after `webcal` rewrite (a config error). */
  | "scheme"
  /** `AbortSignal.timeout` fired before the response completed. */
  | "timeout"
  /** Transport-level failure (DNS, connection reset, TLS, …). */
  | "network"
  /** A non-2xx, non-304 HTTP status. */
  | "http";

/**
 * Outcome of one conditional GET (§4):
 * - `modified` — `200`; a fresh body to re-parse, plus the new validators to store.
 * - `not-modified` — `304`; reuse the cached parsed set, do not re-parse.
 * - `error` — any failure; the caller keeps counting on its stale cache (§9).
 */
export type FeedFetchResult =
  | { kind: "modified"; text: string; validators: FeedValidators }
  | { kind: "not-modified" }
  | { kind: "error"; reason: FeedFetchError; status?: number };

export interface FetchFeedOptions {
  /** Validators from the previous successful poll, for the conditional GET. */
  validators?: FeedValidators;
  /** Per-request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Injectable `fetch` — defaults to the global; tests supply a fake (no network). */
  fetchImpl?: typeof fetch;
}

/**
 * Rewrite `webcal://` / `webcals://` to `https://` and reject anything that is
 * not `http(s)` afterwards (§4). Exported for the Property Inspector's `[Test]`
 * button (§11) and validated once at config time; {@link fetchFeed} also calls
 * it and maps a rejection to an `error: "scheme"` result.
 *
 * @throws {TypeError} if the URL is unparseable or not `http(s)` after rewrite.
 *   The message never includes the URL.
 */
export function normalizeFeedUrl(raw: string): string {
  // webcal(s) is the same transport as http(s); Google/Apple hand these out.
  // Rewrite the scheme on the raw string — the WHATWG URL `protocol` setter
  // won't switch a non-special scheme (`webcal:`) to a special one (`https:`).
  const rewritten = raw.trim().replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(rewritten);
  } catch {
    throw new TypeError("feed URL is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TypeError("feed URL scheme must be http(s) or webcal(s)");
  }
  return u.toString();
}

/**
 * Perform one conditional GET against a feed (§4).
 *
 * - Rewrites `webcal` → `https`; a bad scheme returns `error: "scheme"`.
 * - Sends **no** `Authorization` header (the secret is the URL path itself).
 * - Sends `If-None-Match` / `If-Modified-Since` from `validators` when present.
 * - Follows redirects (feeds commonly 302).
 * - Aborts after `timeoutMs`; the resulting `AbortError` maps to `error: "timeout"`.
 * - `304` → `not-modified`; `200` → `modified` (body + fresh validators);
 *   any other status → `error: "http"` with the code.
 *
 * Never throws for network/HTTP conditions and never surfaces the URL in the
 * result — the caller may log the returned reason/status safely.
 */
export async function fetchFeed(
  rawUrl: string,
  opts: FetchFeedOptions = {},
): Promise<FeedFetchResult> {
  const { validators, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = opts;

  let url: string;
  try {
    url = normalizeFeedUrl(rawUrl);
  } catch {
    return { kind: "error", reason: "scheme" };
  }

  // Conditional-GET headers. No Authorization — the capability is in the path.
  const headers: Record<string, string> = {};
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError/AbortError; everything
    // else is a transport failure. We map by name and DISCARD the error object
    // so its message (which may echo the URL) never escapes this module.
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "error", reason: "timeout" };
    }
    return { kind: "error", reason: "network" };
  }

  if (res.status === 304) return { kind: "not-modified" };

  if (res.status >= 200 && res.status < 300) {
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { kind: "error", reason: "network" };
    }
    // Prefer ETag over Last-Modified when the server offered both (§4).
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    const fresh: FeedValidators = {};
    if (etag) fresh.etag = etag;
    if (lastModified) fresh.lastModified = lastModified;
    return { kind: "modified", text, validators: fresh };
  }

  return { kind: "error", reason: "http", status: res.status };
}
