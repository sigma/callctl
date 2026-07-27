# Extracting a video-call join URL from an iCal (RFC 5545) event

> Research asset for a plugin-side **"Next Meeting"** Stream Deck action: given the
> user's calendar (an `.ics` feed / file), find the *joinable* meeting URL for the
> next event and open it on a key press.
> Sources: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html) (the iCalendar
> spec itself), provider conventions cross-checked against
> [Microsoft Teams deep-link docs](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams),
> and the actual source of the Node ics libraries
> ([`ical.js`](https://github.com/kewisch/ical.js),
> [`node-ical`](https://github.com/jens-maus/node-ical)). Reference plugin mined for
> library choice: [`pedrofuentes/stream-deck-ical`](https://github.com/pedrofuentes/stream-deck-ical)
> (MIT) — **not copied**; it has no join-URL logic. AFK research.

## TL;DR for the extraction function

- **Never regex the raw `.ics` text.** RFC 5545 §3.1 folds every content line at
  75 octets by inserting `CRLF` + one space; a long join URL is routinely split
  mid-string. Read the **parsed, unfolded property value** from a library instead.
- **Use a library with named-property access**, not a hand-rolled grammar. Recommend
  [`ical.js`](https://github.com/kewisch/ical.js) (this is also what the reference
  plugin uses). Access is `comp.getFirstPropertyValue('x-google-conference')`,
  `'location'`, `'description'`, `'url'` — the non-standard `X-` prop is reachable by
  its full lowercased name, which is exactly what the precedence chain needs.
- **Precedence (first hit wins):**
  `X-GOOGLE-CONFERENCE` → `LOCATION` (if it *is* a URL) → first URL embedded in
  `DESCRIPTION` (and `X-ALT-DESC` for Teams/Outlook) → `URL` property.
- **Per provider:** Google Meet → `X-GOOGLE-CONFERENCE` (also mirrored into
  LOCATION/DESCRIPTION); Zoom → `LOCATION`; Teams → an embedded
  `teams.microsoft.com/l/meetup-join/…` link inside DESCRIPTION/X-ALT-DESC; generic
  → embedded URL in DESCRIPTION or the `URL` property.
- **"Has a join link" predicate** = *the precedence chain yields a syntactically
  valid `http(s)` URL*. That single boolean drives the Next-Meeting scope filter
  (skip events with no joinable link).

## Why this is a convention, not a standard

RFC 5545 defines the **containers** (`LOCATION`, `DESCRIPTION`, `URL`, and the `X-`
extension mechanism) but says **nothing** about putting a *video-conference join
link* in any of them. No provider publishes a normative "we place the join URL in
property _X_" spec either. So the per-provider mapping below is a **de-facto
convention** established by inspecting the `.ics` those providers actually emit,
anchored to the RFC only for (a) what each property *means* and (b) that `X-`
extensions are legal. Treat the mapping as heuristics ordered by reliability, not as
a contract — hence the fallback chain.

## 1. Field precedence for locating the join URL

Order, most-authoritative first. Each rung is tried only if the previous produced no
valid URL (see the predicate in §3).

| # | Property | Why it ranks here |
|---|----------|-------------------|
| 1 | **`X-GOOGLE-CONFERENCE`** | When present it is an *unambiguous, purpose-built* carrier: a single bare Meet URL, no prose to parse, no venue ambiguity. It only appears when Google actually attached a Meet conference, so a hit is high-confidence. |
| 2 | **`LOCATION`** (when the value *is* a URL) | RFC 5545 §3.8.1.7: LOCATION specifies "the intended venue for the activity." Some providers (notably Zoom) put the bare join URL here as the "venue." Rank it above DESCRIPTION because when it holds a URL it is a *single, whole* value — no extraction from prose. Guard: LOCATION is free `TEXT`, so it is often a physical address ("Room 4B") — only accept it if it parses as an `http(s)` URL. |
| 3 | **`DESCRIPTION`** (first embedded URL) | RFC 5545 §3.8.1.5: DESCRIPTION is "a more complete description … than that provided by the SUMMARY." It is `TEXT`, i.e. human prose, so the join link is *embedded* among other text and must be scanned out (URL-in-string). Lower rank because extraction is fuzzier (multiple URLs: join link, dial-in help page, unsubscribe, map). Teams/Outlook also mirror the body into **`X-ALT-DESC`** (HTML) — search both. |
| 4 | **`URL`** | RFC 5545 §3.8.4.6: "a uniform resource locator associated with the iCalendar object." Semantically it points at the *event's* resource (an event page), not necessarily the *conference*. Real feeds frequently set it to a calendar-permalink rather than a join link, so it is the last resort — only used when nothing better matched. |

Rationale for the overall shape: **descend from "dedicated single-value field" to
"prose you must mine," and prefer fields whose *presence* implies a real
conference.** Rungs 1–2 give whole URLs; rungs 3–4 are salvage.

## 2. Per-provider population

What each provider actually puts where (observed in emitted `.ics`; anchored to the
RFC only for property semantics and the legality of `X-`).

| Provider | Primary carrier | Also seen in | Link shape |
|----------|-----------------|--------------|------------|
| **Google Meet** | `X-GOOGLE-CONFERENCE` (non-standard `X-` prop) | mirrored into `LOCATION` and/or `DESCRIPTION` | `https://meet.google.com/<xxx-xxxx-xxx>` |
| **Zoom** | `LOCATION` (bare join URL as the "venue") | full details (ID/passcode/dial-in) in `DESCRIPTION` | `https://<subdomain>.zoom.us/j/<id>?pwd=…` |
| **Microsoft Teams** | embedded URL in `DESCRIPTION` / `X-ALT-DESC` | — | `https://teams.microsoft.com/l/meetup-join/19:meeting_…@thread.v2/0?context=…` |
| **Generic invite** | embedded URL in `DESCRIPTION`, or the `URL` property | `LOCATION` (sometimes) | any `http(s)` link |

Notes and their sources:

- **`X-GOOGLE-CONFERENCE` is a legal non-standard property.** RFC 5545 **§3.8.8.2
  Non-Standard Properties** explicitly reserves the `X-` prefix ("Reserved for
  experimental use"), with the `X-name` production defined in §3.1
  (`X-name = "X-" [vendorid "-"] 1*(ALPHA / DIGIT / "-")`). So a parser must be able
  to surface arbitrary `X-` props — see §5. There is no *normative* Google spec for
  its contents; it is observed to hold a single bare Meet URL. Google typically also
  duplicates the Meet link into LOCATION and the DESCRIPTION body, which is why rungs
  2–3 still catch Meet even if the `X-` prop is stripped by an intermediary.
- **Zoom → LOCATION.** Zoom-emitted events place the bare join URL in LOCATION (the
  "venue"), with the human-readable meeting ID/passcode/dial-in block in DESCRIPTION.
  This is convention, not a Zoom spec; validate LOCATION as a URL (§1 rung 2 guard).
- **Teams → embedded `meetup-join` link.** Teams/Outlook write the join link into the
  event body (DESCRIPTION plus an HTML `X-ALT-DESC`), not a dedicated property. The
  link is a *deep link* of the documented form
  `https://teams.microsoft.com/l/meetup-join/<19:meeting_…@thread.v2>/0?context={"Tid":…,"Oid":…}`
  — the `l/…` deep-link family is documented at
  [Microsoft Learn — Deep links](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams)
  and [msteams-docs `deep-link-workflow.md`](https://github.com/MicrosoftDocs/msteams-docs/blob/main/msteams-platform/concepts/build-and-test/deep-link-workflow.md).
  Match it by host+path (`teams.microsoft.com` + `/l/meetup-join/`) when several URLs
  live in the body.

## 3. The predicate: "does this event have a join link?"

Used as the **scope filter** for the Next-Meeting action — an event qualifies only if
extraction yields a valid join URL. Define one function; the boolean is just "did it
return non-null."

```
joinUrl(event):
  1. v = X-GOOGLE-CONFERENCE          ; if isJoinUrl(v) -> return v
  2. v = LOCATION                     ; if isJoinUrl(v) -> return v         (whole-value URL)
  3. v = firstUrlIn(DESCRIPTION)                                            ; prefer a known
         ?? firstUrlIn(X-ALT-DESC)    ; if isJoinUrl(v) -> return v          provider host if
                                                                             several match
  4. v = URL                          ; if isJoinUrl(v) -> return v
  return null   // -> event has NO join link; excluded from Next-Meeting scope

hasJoinLink(event) := joinUrl(event) != null
```

`isJoinUrl(s)`:

- parses with `new URL(s)` (throws ⇒ not a URL), and
- `protocol` is `http:` or `https:` (reject `mailto:`, `tel:`, physical addresses).
- Optional strengthening for step 3's disambiguation: when multiple URLs are embedded,
  prefer one whose host is a **known conferencing host**
  (`meet.google.com`, `*.zoom.us`, `teams.microsoft.com`, `teams.live.com`,
  `*.webex.com`, …) before falling back to the first `http(s)` URL found.

`firstUrlIn(text)`: scan the **already-unfolded** property value for `https?://…`
tokens (whitespace/`<>`/`"`-delimited). This regex is over a *single logical value*
returned by the parser, **not** over the raw `.ics` — see §4.

## 4. iCal line-folding — why raw-text regex breaks

**RFC 5545 §3.1 (Content Lines):** "Lines of text SHOULD NOT be longer than 75
octets, excluding the line break." A long line "can be split between any two
characters by inserting a CRLF immediately followed by a single linear white-space
character (i.e., SPACE or HTAB)." Unfolding is the inverse: "Any sequence of CRLF
followed immediately by a single linear white-space character is ignored (i.e.,
removed) when processing the content type."

Consequence for a join URL, which is easily > 75 octets. A Teams `meetup-join` link
in the `.ics` bytes looks like:

```
DESCRIPTION:Join the meeting: https://teams.microsoft.com/l/meetup-join/19%3Amee
 ting_ZGJlZDQ4ZTUt...@thread.v2/0?context=%7B%22Tid%22%3A...%7D  Thanks!
```

The folded boundary (`…meetup-join/19%3Amee` + `CRLF SPACE` + `ting_…`) sits **inside
the URL**. A regex run over the raw file body:

- either **captures a truncated URL** (`…/l/meetup-join/19%3Amee`) if the pattern
  stops at whitespace/newline, or
- **captures garbage** (`…mee ting_…` with an injected space) if it spans the break.

Either way the opened link is wrong or dead. There is no reliable way to
"regex-around" folding without effectively re-implementing the unfolder — and
ad-hoc regex parsing of a structured format is precisely the brittle-parser
anti-pattern to avoid.

**Correct approach:** let the library unfold. Every conformant iCal parser removes
`CRLF`+WSP before exposing a value, so `getFirstPropertyValue('description')` returns
the *single, whole, unfolded* string. Run URL extraction (§3's `firstUrlIn`) on **that
value**, never on the file text.

## 5. Library recommendation

Use a real parser with **named-property access**; do not hand-roll a `BEGIN:VEVENT`
grammar. The whole precedence chain (§1) depends on being able to ask for
`LOCATION`, `DESCRIPTION`, `URL`, and the non-standard `X-GOOGLE-CONFERENCE` by name
and get an unfolded value back.

| Library | Non-standard `X-` access | Standard props | Verdict |
|---------|--------------------------|----------------|---------|
| **[`ical.js`](https://github.com/kewisch/ical.js)** (kewisch) | `comp.getFirstPropertyValue('x-google-conference')` — full lowercased name preserved | `getFirstPropertyValue('location'\|'description'\|'url')` | **Recommended.** Predictable name-keyed access; already the reference plugin's choice. |
| **[`node-ical`](https://github.com/jens-maus/node-ical)** | surfaces unknown props on the event object, but **strips the `X-` prefix** (see below) — footgun | `event.location`, `event.description`, `event.url` (lowercased keys) | Fine for standard props; verify the exact `X-` key empirically before relying on it. |
| **[`ical-expander`](https://github.com/mifi/ical-expander)** | wraps `ical.js` → same `getFirstPropertyValue` on the underlying component | via `ical.js` | Good if you also need robust recurrence expansion; access pattern identical to `ical.js`. |

### `ical.js` (recommended) — how access works

`ICAL.Component` exposes `getFirstProperty(name)`, `getFirstPropertyValue(name)`, and
`getAllProperties(name)`; the `name` argument is the **lowercased** property name, and
`getFirstPropertyValue` "returns first property's value, if available" (or `null`)
([API docs](https://kewisch.github.io/ical.js/api/ICAL.Component.html)). Because the
non-standard property is stored under its full lowercased name, `X-GOOGLE-CONFERENCE`
is reachable as `'x-google-conference'` — no prefix surprise:

```js
import ICAL from "ical.js";

const comp  = new ICAL.Component(ICAL.parse(icsText));   // unfolds per §3.1
const vevent = comp.getFirstSubcomponent("vevent");      // ICAL.Component

const meet = vevent.getFirstPropertyValue("x-google-conference"); // Google Meet
const loc  = vevent.getFirstPropertyValue("location");            // Zoom / venue
const desc = vevent.getFirstPropertyValue("description");         // Teams/generic body
const alt  = vevent.getFirstPropertyValue("x-alt-desc");          // Teams HTML body
const url  = vevent.getFirstPropertyValue("url");                 // last resort
```

Each returned value is already unfolded, so `firstUrlIn(desc)` (§3) operates on a
whole string. This is the concrete backbone of the extraction function.

### `node-ical` — the `X-` footgun

`node-ical` stores standard props as lowercased keys (`event.location`,
`event.description`, `event.url`). For non-standard props its parser
([`ical.js` in jens-maus/node-ical](https://github.com/jens-maus/node-ical/blob/master/ical.js))
takes the `X-` branch, **slices off the `"X-"` prefix**, and stores the remainder
(rather than the full `x-google-conference` key):

```js
if (/X-(?:\w|-)+/v.test(name) && stack.length > 0) {
  name = name.slice(2);                 // "X-GOOGLE-CONFERENCE" -> "GOOGLE-CONFERENCE"
  return storeParameter(name)(value, parameters, ctx, stack, line);
}
return storeParameter(name.toLowerCase())(value, parameters, ctx);   // non-X fallback: lowercased
```

So with `node-ical` you would look up `event['GOOGLE-CONFERENCE']`, **not**
`event['x-google-conference']` — the exact resulting key/casing should be confirmed
empirically against your `node-ical` version before shipping. This unpredictability
(vs. `ical.js`'s stable `getFirstPropertyValue('x-google-conference')`) is the reason
to prefer `ical.js`, and it directly contradicts the common assumption that
`node-ical` exposes the prop under its full `x-google-conference` name.

### Reference plugin (`pedrofuentes/stream-deck-ical`)

A mature MIT iCal *countdown* Stream Deck plugin. Its `package.json` depends on
**`ical.js` (^2.2.1)** plus `rrule`, `luxon`, and `windows-iana`; it parses via
`ical.js` and does per-event error isolation and RRULE/EXDATE expansion. **It never
extracts or opens a meeting URL** — no join-URL code exists to borrow. It validates
the library choice and the parsing approach; the join-URL extraction (§1–§4) is our
net-new feature.

## Open items this hands downstream

- **Known-host allow-list** for §3's multi-URL disambiguation (Meet/Zoom/Teams/Webex
  hosts) — decide the initial set and where it lives (protocol vs plugin config).
- **Recurrence:** the Next-Meeting action needs the *next occurrence's* event, so pair
  the extractor with RRULE expansion (`ical-expander`, or `rrule` as the reference
  plugin does). Extraction operates per resolved occurrence.
- **`X-ALT-DESC` HTML:** when only the HTML body has the link, strip tags/entities
  before `firstUrlIn`, or match the `href`.
