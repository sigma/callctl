/**
 * Join-URL extraction, canonicalization & tiering (§6) — the security-critical
 * core of Next-Meeting.
 *
 * Given a parsed node-ical VEVENT this module returns a **tiered, canonicalized**
 * {@link JoinCandidate} — never a raw URL. The governing invariant (§6.2):
 *
 *   > The attacker never controls the URL's scheme or host.
 *
 * Calendar invites are attacker-controllable, so "parses as `http(s)`" is not
 * sufficient. For each recognized provider we extract only the characterizing
 * token, strict-validate it, and **reconstruct** the URL from a hard-coded
 * template. Any validation mismatch **demotes** a recognized link to tier (b)
 * (a marker; the opener falls back to a feed-derived calendar URL) — it never
 * throws and never yields a dead key. Patterns are plain constants, deliberately
 * *not* config-over-the-wire (§6.2, §12).
 */

import type { JoinCandidate, ParsedEvent } from "./types.js";

// ── Canonicalization patterns (§6.2) — hard-coded, never config-over-the-wire ──

/** Google Meet code, e.g. `abc-def-ghi`. */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
/** Zoom host: `zoom.us` or a single `<sub>.zoom.us` label. */
const ZOOM_HOST = /^([a-z0-9-]{1,63}\.)?zoom\.us$/;
/** Zoom numeric meeting id. */
const ZOOM_ID = /^\d{9,11}$/;
/** Zoom `pwd` param — the only query param preserved, and only if it matches. */
const ZOOM_PWD = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Conferencing hosts preferred when a description body embeds several URLs
 * (§6.1 disambiguation). Broader than the canonicalizable set on purpose: a
 * Webex or `teams.live.com` link is a better *candidate* than a random body
 * link even though it demotes to tier (b) downstream.
 */
const KNOWN_HOST = (host: string): boolean =>
  host === "meet.google.com" ||
  host === "zoom.us" ||
  host.endsWith(".zoom.us") ||
  host === "teams.microsoft.com" ||
  host === "teams.live.com" ||
  host === "webex.com" ||
  host.endsWith(".webex.com");

/**
 * `true` iff `s` parses as an absolute URL whose scheme is `http`/`https`.
 * Rejects `mailto:`, `tel:`, and physical addresses (§6.1). Uses the real URL
 * parser — never a regex — to decide validity.
 */
export function isJoinUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

/**
 * Scan a single unfolded property value for `http(s)` URL tokens (whitespace /
 * `<>` / `"`-delimited), returning those that validate as join URLs. The regex
 * only *finds* candidate substrings; each is then validated with the real URL
 * parser via {@link isJoinUrl}.
 */
function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    // Free-text URLs commonly abut trailing punctuation ("…join: <url>.").
    const candidate = m[0].replace(/[.,;:!?)\]}>'"]+$/, "");
    if (isJoinUrl(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * The first join URL embedded in `text`, preferring a known conferencing host
 * over an arbitrary earlier link (§6.1 disambiguation). `undefined` if none.
 */
export function firstUrlIn(text: string): string | undefined {
  const urls = urlsIn(text);
  return urls.find((u) => KNOWN_HOST(new URL(u).hostname.toLowerCase())) ?? urls[0];
}

/** Read a node-ical property to its unfolded string value (unwrapping `{ params, val }`). */
function readProp(p: unknown): string | undefined {
  const v = Array.isArray(p) ? p[0] : p;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "string") {
    return (v as { val: string }).val;
  }
  return undefined;
}

/**
 * Walk the §6.1 precedence table and return the first property that yields a
 * valid `http(s)` URL, or `undefined` if the event carries no join candidate.
 */
function extractCandidateUrl(ev: ParsedEvent): string | undefined {
  // Rung 1 — Google conference (X-GOOGLE-CONFERENCE, de-prefixed): a plain URL.
  const gconf = readProp(ev["GOOGLE-CONFERENCE"])?.trim();
  if (gconf && isJoinUrl(gconf)) return gconf;

  // Rung 2 — LOCATION: only when the *whole* value is a URL (Zoom's carrier).
  const loc = readProp(ev.location)?.trim();
  if (loc && isJoinUrl(loc)) return loc;

  // Rung 3 — DESCRIPTION body: first embedded URL.
  const desc = readProp(ev.description);
  if (desc) {
    const u = firstUrlIn(desc);
    if (u) return u;
  }

  // Rung 3b — X-ALT-DESC body (de-prefixed; `{ params, val }` when FMTTYPE set).
  const alt = readProp(ev["ALT-DESC"]);
  if (alt) {
    const u = firstUrlIn(alt);
    if (u) return u;
  }

  // Rung 4 — URL property: a plain URL.
  const url = readProp(ev.url)?.trim();
  if (url && isJoinUrl(url)) return url;

  return undefined;
}

/**
 * Canonicalize a candidate URL into a tier-(a) result, or `null` when it is not
 * canonicalizable — either an **unknown provider** or a **recognized provider
 * with an invalid token**. Both `null` outcomes demote to tier (b) upstream;
 * the distinction does not survive because both open the feed-derived fallback.
 */
function canonicalize(raw: string): JoinCandidate | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();

  // Google Meet — full reconstruct; discard all query and fragment.
  if (host === "meet.google.com") {
    const code = u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (MEET_CODE.test(code)) {
      return {
        tier: "a",
        provider: "gmeet",
        code: `gmeet:${code}`,
        joinUrl: `https://meet.google.com/${code}`,
      };
    }
    return null; // recognized host, bad code → demote to tier (b)
  }

  // Zoom — host-validate + reconstruct `/j/<id>`, preserving only a valid `pwd`.
  if (ZOOM_HOST.test(host)) {
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg[0] === "j" && seg[1] && ZOOM_ID.test(seg[1])) {
      const id = seg[1];
      const pwd = u.searchParams.get("pwd");
      const query = pwd && ZOOM_PWD.test(pwd) ? `?pwd=${pwd}` : "";
      return {
        tier: "a",
        provider: "zoom",
        code: `zoom:${id}`,
        joinUrl: `https://${host}/j/${id}${query}`,
      };
    }
    return null; // recognized host, no valid `/j/<id>` → demote to tier (b)
  }

  // Microsoft Teams — host-pinned allowlist passthrough (opaque token untouched).
  if (
    u.protocol === "https:" &&
    host === "teams.microsoft.com" &&
    u.pathname.startsWith("/l/meetup-join/")
  ) {
    return { tier: "a", provider: "teams", joinUrl: raw };
  }

  return null; // unknown provider → demote to tier (b)
}

/**
 * Extract, canonicalize, and tier the join candidate of a parsed VEVENT (§6.3).
 *
 * - **tier (a)** — recognized provider, valid token → reconstructed URL.
 * - **tier (b)** — a candidate exists but is an unknown provider or an invalid
 *   token → a bare marker; the event is still surfaced, the opener supplies a
 *   feed-derived calendar URL.
 * - **tier (c)** — no candidate → `null`; the instance is dropped from selection.
 */
export function extractJoinCandidate(ev: ParsedEvent): JoinCandidate | null {
  const url = extractCandidateUrl(ev);
  if (url === undefined) return null; // tier (c)
  return canonicalize(url) ?? { tier: "b" }; // tier (a), else demote to (b)
}
