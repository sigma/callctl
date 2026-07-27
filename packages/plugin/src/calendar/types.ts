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
