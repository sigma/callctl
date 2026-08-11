/**
 * Attendance & cancellation verdict (§5.1) — pure predicates over a parsed
 * occurrence, with no Stream Deck, network or settings imports.
 *
 * The policy is **allow by default**: an occurrence is non-attending on exactly
 * two conditions — the organizer said `STATUS:CANCELLED`, or *you* said
 * `PARTSTAT=DECLINED`. Everything else is kept, which is also what RFC 5545
 * §3.2.12 mandates (`PARTSTAT` defaults to `NEEDS-ACTION`, and unrecognized
 * values MUST be read as `NEEDS-ACTION`). The asymmetry is deliberate: an
 * unwanted flash is annoying, a silently-hidden meeting is harm.
 *
 * This module **marks**; it never drops. The drop is one clause in §10's
 * `applyDismissal`, so a meeting you declined and then joined anyway is
 * rescuable.
 */

import type { CalendarResponse } from "node-ical";
import type { IcalProperty, ParsedEvent } from "./types.js";

/** Unwrap one node-ical property entry (`string` | `{ params, val }`) to its value. */
function entryVal(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const v = (entry as { val?: unknown }).val;
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** The `params` bag of one node-ical property entry, or `undefined` for a bare string. */
function entryParams(entry: unknown): Record<string, unknown> | undefined {
  if (entry && typeof entry === "object") {
    const p = (entry as { params?: unknown }).params;
    if (p && typeof p === "object") return p as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Every entry of a possibly-repeated property. `attendee` is **object-or-array**
 * on node-ical — a bare object when the event carries exactly one `ATTENDEE` —
 * and *every* entry must be scanned, so §6.1's read-the-first-element convention
 * deliberately does not carry over here.
 */
function entries(prop: IcalProperty | unknown): unknown[] {
  if (prop === undefined || prop === null) return [];
  return Array.isArray(prop) ? prop : [prop];
}

/** Normalize an address for comparison: `mailto:` stripped, trimmed, lower-cased. */
function normalizeAddress(raw: string): string {
  const s = raw.trim();
  const bare = /^mailto:/i.test(s) ? s.slice("mailto:".length) : s;
  return bare.trim().toLowerCase();
}

/**
 * A loose structural check that `s` looks like an email address: exactly one
 * `@`, both sides non-empty, and a dot in the domain. Deliberately **not** an
 * RFC 5322 regex — its only job is to reject calendar display names such as
 * `Arbora Team` before they are used as an identity (§5.1).
 */
export function isEmailShaped(s: string): boolean {
  const parts = s.trim().split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0 || domain.length === 0) return false;
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/**
 * Canonical form of a configured identity list: each address normalized
 * ({@link normalizeAddress}), blanks dropped, deduplicated, and **sorted** — so
 * two lists that differ only in case, `mailto:` prefixing, whitespace, ordering
 * or repetition compare equal. `CalendarService` compares this form to decide
 * whether an identity edit is a real change (§4).
 */
export function normalizeIdentities(raw: readonly string[] | undefined): string[] {
  const cleaned = (raw ?? []).map((s) => normalizeAddress(s)).filter((s) => s.length > 0);
  return [...new Set(cleaned)].sort();
}

/**
 * Which rung of the §5.1 precedence ladder answered — `"configured"` (explicit
 * `NamedFeed.identities`), `"inferred"` (read off `X-WR-CALNAME`), or `"none"`
 * (neither, so the declined half is a no-op). A poll ignores this; §11's
 * `[Test]` report is the one surface that has to *name* where the identity came
 * from, and it must be the same answer the poll used.
 */
export type IdentitySource = "configured" | "inferred" | "none";

/** The resolved §5.1 identity plus the ladder rung it came from. */
export interface ResolvedIdentity {
  source: IdentitySource;
  /** Normalized (lower-cased, `mailto:`-free) addresses; empty iff `source` is `"none"`. */
  addresses: string[];
}

/**
 * Resolve the addresses that count as "me" for one feed's poll (§5.1), in
 * precedence order:
 *
 * 1. **Configured** `NamedFeed.identities` when non-empty — explicit wins
 *    **outright**, inference never unions in, or a bad inference would be
 *    impossible to switch off.
 * 2. **Inferred** from the VCALENDAR-level `X-WR-CALNAME` when it is
 *    email-shaped (on a primary Google calendar this is the owner's address, so
 *    the common case needs no setup). node-ical de-prefixes `X-` keys preserving
 *    case, so this reads `parsed.vcalendar["WR-CALNAME"]`.
 * 3. **Neither ⇒ empty** — the declined half of the verdict becomes a pure
 *    no-op and the feed behaves exactly as it did before. The *cancelled* half
 *    is ungated and keeps working, so an unidentifiable feed fails toward
 *    **showing** the meeting, never hiding it.
 *
 * Inference is **ephemeral**: recomputed each poll, never written back to
 * settings (a background poll writing user settings races the PI editor).
 *
 * The ladder lives **here only**: {@link resolveIdentities} is the poll's view of
 * it (addresses alone) and §11's `[Test]` report is the labelled view, so the two
 * cannot describe different rules.
 *
 * @param parsed the feed body, or `null` when there is none to infer from (a
 *               `304` with no cached body) — configured identities still stand.
 */
export function resolveIdentityWithSource(
  configured: readonly string[] | undefined,
  parsed: CalendarResponse | null,
): ResolvedIdentity {
  const explicit = normalizeIdentities(configured);
  if (explicit.length > 0) return { source: "configured", addresses: explicit };

  const vcalendar = (parsed as unknown as Record<string, unknown> | null)?.vcalendar;
  const calName = entryVal(
    entries((vcalendar as Record<string, unknown> | undefined)?.["WR-CALNAME"])[0],
  );
  if (calName !== undefined && isEmailShaped(calName)) {
    return { source: "inferred", addresses: [normalizeAddress(calName)] };
  }

  return { source: "none", addresses: [] };
}

/**
 * The poll's view of {@link resolveIdentityWithSource}: just the addresses.
 *
 * @returns normalized (lower-cased, `mailto:`-free) addresses, deduplicated.
 */
export function resolveIdentities(
  configured: readonly string[] | undefined,
  parsed: CalendarResponse,
): string[] {
  return resolveIdentityWithSource(configured, parsed).addresses;
}

/**
 * The §5.1 verdict for a single **expanded occurrence** — `false` when the
 * occurrence is cancelled or declined, `true` otherwise.
 *
 * Must be evaluated against `occ.event`, **never** the master `VEVENT`: a
 * cancelled or declined single occurrence of an otherwise-fine series arrives as
 * a `RECURRENCE-ID` override carrying its own `STATUS`/`PARTSTAT`, and testing
 * the master would silently no-op.
 *
 * `false` iff either:
 *
 * 1. `STATUS` equals `CANCELLED` (case-insensitive) — **unconditional**, since
 *    the organizer's voice needs no identity to hear; or
 * 2. some `ATTENDEE` whose address matches a resolved identity carries
 *    `PARTSTAT` exactly `DECLINED` (case-insensitive).
 *
 * `TRANSP` is **never consulted** (§5.1's explicit non-rule): it is a free/busy
 * signal, not an attendance one. Matching compares each `ATTENDEE`'s **`val`**
 * with `mailto:` stripped — never `CN`, which is a display name that only
 * coincidentally equalled the address on the feed observed in #88.
 *
 * @param event      the parsed occurrence (`occ.event`).
 * @param identities resolved addresses from {@link resolveIdentities}; empty
 *                   makes the declined half a no-op.
 */
export function isAttending(event: ParsedEvent, identities: readonly string[]): boolean {
  const status = entryVal(entries(event.status)[0]);
  if (status !== undefined && status.trim().toUpperCase() === "CANCELLED") return false;

  if (identities.length === 0) return true;
  const mine = new Set(identities.map((s) => normalizeAddress(s)));

  for (const entry of entries(event.attendee)) {
    const val = entryVal(entry);
    if (val === undefined || !mine.has(normalizeAddress(val))) continue;
    const partstat = entryParams(entry)?.PARTSTAT;
    if (typeof partstat === "string" && partstat.trim().toUpperCase() === "DECLINED") return false;
  }

  return true;
}
