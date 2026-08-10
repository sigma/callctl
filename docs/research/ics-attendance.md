# ICS attendance, cancellation & time transparency — what feeds actually carry

> Research asset for [Map: which calendar events earn a next-meeting key](https://github.com/sigma/callctl/issues/87),
> ticket [#89](https://github.com/sigma/callctl/issues/89). AFK research.
> Primary sources: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.txt) (iCalendar),
> [RFC 5546](https://www.rfc-editor.org/rfc/rfc5546.txt) (iTIP),
> [RFC 7986](https://www.rfc-editor.org/rfc/rfc7986.html) (new iCalendar properties),
> [MS-OXCICAL](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/),
> [Google Calendar API v3](https://developers.google.com/workspace/calendar/api/v3/reference/events),
> plus an **empirical probe of `node-ical@0.27.1`** (the parser in
> `packages/plugin/src/calendar/engine.ts`) run against a synthetic feed.

## TL;DR for the selection policy

1. **`PARTSTAT` is real and well-specified** — it is a *parameter on `ATTENDEE`*, values
   `NEEDS-ACTION` / `ACCEPTED` / `DECLINED` / `TENTATIVE` / `DELEGATED`, defaulting to
   `NEEDS-ACTION`. See [§1](#1-partstat).
2. **There is NO standardized, feed-intrinsic way to identify the subscriber.** Neither
   RFC 5545, RFC 5546, nor RFC 7986 defines a "this feed belongs to X" property. The only
   candidate is the **non-standard `X-WR-CALNAME`**, which Google populates with the
   calendar id (= the owner's email address for a primary personal calendar) — but that is
   **undocumented by Google** and unverified here. See [§2](#2-identifying-the-subscriber)
   — this is the crux of [#90](https://github.com/sigma/callctl/issues/90) and it does
   **not** resolve from primary sources alone.
3. **The spec says a published feed MUST NOT carry `ATTENDEE` at all.** RFC 5545 §3.8.4.1
   and RFC 5546 §3.2.1 both say so, flatly. Every major provider violates this in personal
   exports (Microsoft's own MS-OXCICAL examples emit `ATTENDEE;PARTSTAT=…`). So we are
   building on *de-facto* behaviour, not spec-guaranteed behaviour, and
   [#88](https://github.com/sigma/callctl/issues/88)'s live capture is load-bearing.
   See [§3](#3-published-vs-scheduled-the-attendee-contradiction).
4. **Whether Google's secret-address ICS retains declined events is UNRESOLVED from primary
   sources.** Google's help pages describe the secret address and the export but say nothing
   about which event states are included. Google's *API* model (`attendees[].self` +
   `responseStatus`) proves the server *knows*, but there is no documented mapping onto the
   ICS serialization. **Needs the live-feed sample (#88).** See [§5](#5-the-declined-question).
5. **`STATUS:CANCELLED` is the right signal for a cancelled occurrence**, and node-ical
   surfaces it as a plain `status` string. Google's API confirms cancelled *exceptions* of a
   recurring series persist as first-class objects rather than vanishing. See [§4](#4-status).
6. **`TRANSP` defaults to `OPAQUE`** and is a *free/busy* signal, not an attendance signal.
   Nothing in the spec makes it a reliable "not a real meeting" proxy. See [§6](#6-transp).
7. **node-ical surfaces everything we need**, with two gotchas: it renames `TRANSP` →
   `transparency` (not `transp`), and it **de-prefixes `X-` keys while preserving their
   uppercase** (`X-WR-CALNAME` → `WR-CALNAME`), unlike ordinary properties which are
   lowercased. See [§7](#7-what-node-ical-actually-gives-us).

---

## 1. `PARTSTAT`

`PARTSTAT` is a **property parameter**, not a property. RFC 5545 §3.2.12:

> Purpose: To specify the participation status for the calendar user specified by the
> property.

The VEVENT value set, verbatim from the ABNF:

```
partstat-event   = ("NEEDS-ACTION"    ; Event needs action
                 / "ACCEPTED"         ; Event accepted
                 / "DECLINED"         ; Event declined
                 / "TENTATIVE"        ; Event tentatively
                                      ; accepted
                 / "DELEGATED"        ; Event delegated
                 / x-name             ; Experimental status
                 / iana-token)        ; Other IANA-registered
                                      ; status
; These are the participation statuses for a "VEVENT".
; Default is NEEDS-ACTION.
```

Two consequences the map's charted decisions already anticipate:

> If not specified on a property that allows this parameter, the default value is
> NEEDS-ACTION. Applications MUST treat x-name and iana-token values they don't recognize
> the same way as they would the NEEDS-ACTION value.
> — RFC 5545 §3.2.12

So an `ATTENDEE` with **no** `PARTSTAT` is spec-equivalent to `NEEDS-ACTION`, and an
**unrecognized** value must also be read as `NEEDS-ACTION`. Since #87 already settled
"`TENTATIVE` and `NEEDS-ACTION` → treated as attending", the safe implementation shape is
an **allow-by-default filter**: drop only on an exact, case-insensitive `DECLINED`. Every
other value — including garbage, including absent — falls through to "attending". That
matches the asymmetry the map called out (an unwanted flash is annoying, a hidden meeting
is harm) and costs nothing extra.

`PARTSTAT` lives on `ATTENDEE` (RFC 5545 §3.8.4.1, "Property Parameters: … participation
status"). It can also legally appear on `ORGANIZER`? No — §3.8.4.3 lists ORGANIZER's
parameters as "IANA, non-standard, language, common name, directory entry reference, and
sent-by" only. **`ORGANIZER` carries no `PARTSTAT`.** If the feed's owner is the organizer
of a meeting, there may be no `ATTENDEE` line for them at all.

### Where PARTSTAT is *supposed* to be set

RFC 5546 §2.1.1: "Each Attendee modifies their ATTENDEE property PARTSTAT parameter to an
appropriate value as part of a REPLY message." The `METHOD:REPLY` restriction table gives
`ATTENDEE` presence `1` — "MUST be the address of the Attendee replying."

That is the *scheduling* path (iTIP mail between organizer and attendee). A subscription
feed is not that path — see §3.

---

## 2. Identifying the subscriber

**This is the finding that matters most, and it is a negative one.**

### Nothing standard exists

- **RFC 5545** defines no VCALENDAR-level owner property. `ORGANIZER` identifies the
  *event's* organizer, and in `VFREEBUSY` it identifies "the calendar that the published
  busy time came from" (§3.8.4.3) — but that scoping is explicitly `VFREEBUSY`-only and does
  not generalize to a `VEVENT` feed.
- **RFC 7986** adds VCALENDAR-level `NAME`, `DESCRIPTION`, `UID`, `LAST-MODIFIED`, `URL`,
  `CATEGORIES`, `REFRESH-INTERVAL`, `SOURCE`, `COLOR`, `IMAGE` — and **no owner or
  subscriber identity property**. `NAME` is a display name ("This property specifies the
  name of the calendar"); `SOURCE` is a refresh URI. Neither is an identity.
- **RFC 5546** has no concept of "the recipient of this feed" — iTIP messages are addressed
  by mail transport, not by an in-band property.

So: **there is no spec-blessed answer.** A subscriber-identity mechanism has to come from a
vendor extension or from configuration.

### The one candidate: `X-WR-CALNAME`

Google's ICS exports carry a VCALENDAR-level `X-WR-CALNAME`, and for a **primary personal
calendar** its value is the calendar id — which *is* the owner's email address
(`X-WR-CALNAME:me@example.com`). If that holds for secret-address feeds, matching
`ATTENDEE` values against it is a feed-intrinsic subscriber identification.

**Caveats, all serious:**

- `X-WR-CALNAME` is **not documented by Google anywhere** in the Calendar API reference or
  the Calendar help centre. Searching Google's own domains for it returns nothing
  authoritative. It is an unregistered, unspecified, de-facto property inherited from early
  Apple iCal. RFC 7986 pointedly does **not** mention it while standardizing the same
  semantic space as `NAME`.
- For a **secondary** calendar it is the calendar's *display name* ("Work", "Family"), not
  an email address at all. Any matcher must tolerate a non-address value.
- For a **subscribed/shared** calendar it names the *source* calendar, which may be someone
  else's address — matching against it would then identify the *wrong* person.
- Microsoft and Apple are not known to emit it with owner semantics.

**Verdict:** treat `X-WR-CALNAME` as a *heuristic hint at best*, never as the primary
mechanism. The per-feed "my email" setting floated in #90 is the only approach that is
correct by construction. If we want the hint, the defensible shape is: use the configured
email when present; optionally *offer* an `X-WR-CALNAME`-derived default in the Property
Inspector that the user confirms — never silently.

### Microsoft's `X-MICROSOFT-CDO-*` family — a near miss

`X-MICROSOFT-CDO-BUSYSTATUS` (MS-OXCICAL) maps to `PidLidBusyStatus`:

| `X-MICROSOFT-CDO-BUSYSTATUS` | `PidLidBusyStatus` |
| --- | --- |
| `FREE` | `0x00000000` |
| `TENTATIVE` | `0x00000001` |
| `BUSY` | `0x00000002` |
| `OOF` | `0x00000003` |

`X-MICROSOFT-CDO-INTENDEDSTATUS` "should be imported into **PidLidIntendedBusyStatus** using
the same import mapping as X-MICROSOFT-CDO-BUSYSTATUS", and is exported when
`METHOD:REQUEST`: it records the busy status the *organizer intended*, as distinct from the
status currently applied to the recipient's copy.

This is **the recipient's own free/busy state**, which is tantalizingly close to "did I
decline" — an Outlook decline typically frees the slot. But:

- It is a **busy-time** value, not a participation status. `FREE` is equally what you get
  from an all-day informational block or a manually-freed meeting you fully intend to attend.
- MS-OXCICAL specifies the *property↔MAPI* mapping, **not** what Outlook/Microsoft 365
  writes into a *published* internet calendar. That is a different pipeline (see §3).
- There is no `X-MICROSOFT-CDO-*` property that names the recipient.

So the CDO family does **not** solve subscriber identification either. It is at most a weak
corroborating signal, and one that #91's `TRANSP` question already covers more directly.

---

## 3. Published vs. scheduled: the `ATTENDEE` contradiction

This is the sharpest spec-vs-practice conflict in the whole area, and it deserves to be
recorded because it explains why we cannot reason from the RFC alone.

**RFC 5545 §3.8.4.1, `ATTENDEE` Conformance:**

> This property MUST be specified in an iCalendar object that specifies a group-scheduled
> calendar entity. **This property MUST NOT be specified in an iCalendar object when
> publishing the calendar information** (e.g., NOT in an iCalendar object that specifies the
> publication of a calendar user's busy time, event, to-do, or journal).

**RFC 5546 §3.2.1, `PUBLISH`:**

> The "Organizer" MUST be present in a published iCalendar component. **"Attendees" MUST NOT
> be present.**

and the `METHOD:PUBLISH` restriction table is unambiguous:

```
|   ATTENDEE         | 0        |                                   |
|   REQUEST-STATUS   | 0        |                                   |
```

By the letter of both RFCs, **a subscription feed carrying `METHOD:PUBLISH` should have no
`ATTENDEE` lines whatsoever**, and therefore no `PARTSTAT` to read.

In practice, exports from Google and Microsoft routinely *do* carry `ATTENDEE` with
`PARTSTAT`. Microsoft's own MS-OXCICAL worked example emits
`ATTENDEE;PARTSTAT=ACCEPTED:mailto:sito@contoso.com` — though note that example is a
`METHOD:REPLY`, not a `PUBLISH`, so it does not itself prove the publish-path behaviour.

RFC 5545 §3.7.2 gives the escape hatch the providers effectively use:

> If this property is not present in the iCalendar object, then a scheduling transaction
> MUST NOT be assumed. In such cases, the iCalendar object is merely being used to transport
> a snapshot of some calendar information …

A feed with **no `METHOD`** is "merely a snapshot", and the `PUBLISH` restrictions in RFC
5546 §3.2.1 then simply don't bind. Whether Google/Microsoft/Apple *omit* `METHOD` for this
reason, or emit `METHOD:PUBLISH` and violate the table, is **not determinable from primary
sources — check it in the #88 capture.** It is worth capturing because it tells us whether
`ATTENDEE` presence is something we can lean on or something we are lucky to get.

**Design consequence:** the selection filter must behave sanely when `ATTENDEE` is absent
entirely. Absent ⇒ no evidence of a decline ⇒ **keep the event**. Same allow-by-default
posture as §1.

---

## 4. `STATUS`

RFC 5545 §3.8.1.11 — VEVENT values are exactly three:

```
statvalue-event = "TENTATIVE"    ;Indicates event is tentative.
                / "CONFIRMED"    ;Indicates event is definite.
                / "CANCELLED"    ;Indicates event was cancelled.
```

> In a group-scheduled calendar component, the property is used by the "Organizer" to
> provide a confirmation of the event to the "Attendees". … the "Organizer" can indicate
> that a meeting is tentative, confirmed, or cancelled.

Note the asymmetry against `PARTSTAT`: **`STATUS` is the organizer's voice, `PARTSTAT` is
the attendee's.** `STATUS:TENTATIVE` means "the organizer hasn't nailed this down", which is
a different fact from `PARTSTAT=TENTATIVE` ("I might come"). #87 settled that
`PARTSTAT=TENTATIVE` is treated as attending; by the same "unwanted flash beats hidden
meeting" logic, `STATUS:TENTATIVE` should also be **kept**. Only `CANCELLED` drops.

`STATUS` has **no documented default**. Absent ⇒ treat as not-cancelled.

### Cancelled occurrences of a recurring series

RFC 5546 §3.2.5 (`CANCEL`) is explicit about the two shapes:

> To cancel the complete range of a recurring event, the "UID" property value for the event
> MUST be specified and a "RECURRENCE-ID" MUST NOT be specified in the "CANCEL" method. In
> order to cancel an individual instance of the event, the "RECURRENCE-ID" property value for
> the event MUST be specified in the "CANCEL" method.

and, for a whole event, `STATUS` "MUST be set to CANCELLED".

For `METHOD:PUBLISH`, `STATUS` "MAY be one of TENTATIVE/CONFIRMED/**CANCELLED**" (RFC 5546
§3.2.1 table) — so a published feed *is* permitted to retain a cancelled event rather than
delete it. The RFC permits both; it mandates neither.

**Two distinct mechanisms produce a "missing" occurrence, and they are not equivalent:**

| Mechanism | Shape in the feed | What we must do |
| --- | --- | --- |
| `EXDATE` on the master | Occurrence removed from the recurrence set (§3.8.5.1: "The exception dates, if specified, are used in computing the recurrence set") | Nothing — the expander never generates it |
| `RECURRENCE-ID` override with `STATUS:CANCELLED` | A **separate VEVENT** with the same `UID`, a `RECURRENCE-ID` pinning the instance, and `STATUS:CANCELLED` | **We must filter it.** It is a real, expandable event object |

This is exactly the case the map flagged: "Matters most for a cancelled *occurrence* of a
recurring series, where the VEVENT does stick around." The `EXDATE` path is already free;
the override path is the one that costs us a filter.

Google's API model corroborates the override path surviving. Per the Events reference,
`status: "cancelled"` means "deleted event", and for recurring events "cancelled exceptions
indicate instances that *should no longer be presented to the user*, while other cancelled
events represent deleted items". The API additionally gates them behind `showDeleted` /
incremental sync — but that is an *API list* behaviour and says **nothing** about the ICS
serialization. Whether the ICS feed includes the cancelled override at all is another
question for #88.

---

## 5. The declined question

**Unresolved from primary sources. This needs the live-feed sample.**

What we can say:

- **Google's server-side model unambiguously knows.** `Events.attendees[]` carries
  `responseStatus` (`needsAction` / `declined` / `tentative` / `accepted`) *and* `self`
  ("Whether this entry represents the calendar on which this copy of the event appears.
  Read-only."). `organizer.self` and `attendees[].organizer` exist too. So the API has a
  **first-class subscriber-identity flag** — `self` is precisely the thing §2 is missing.
- **`self` has no known iCalendar counterpart.** There is no registered parameter and no
  documented Google `X-` parameter for it. If the ICS feed had, say,
  `ATTENDEE;X-GOOGLE-SELF=TRUE`, #90 would be trivial. **Look for exactly this in the #88
  capture** — a Google-specific `X-` parameter on the owner's `ATTENDEE` line would be the
  single highest-value discovery available, and node-ical would surface it as an
  ordinary key inside `params` (see §7).
- **Google's help documentation is silent.** "Sync your calendar with computer programs"
  (answer/37648) documents the Secret Address as a read-only view — "The Secret Address lets
  you view your calendar in other applications" — and says nothing about update frequency,
  inclusion rules, or event states. "Export events from your Google Calendar" (answer/37111)
  likewise describes the mechanics of the `.ics` download with **no statement whatsoever**
  about declined, cancelled, or invited-to-only events.
- **Google Calendar has a UI-level "show declined events" preference** — which, if it
  behaves as its name suggests, shows declined events *do* remain in the user's calendar
  rather than being deleted on decline, making "the ICS omits them entirely" the less likely
  hypothesis. ⚠️ **Not primary-sourced.** This setting is attested only in Google Calendar
  *community forum* threads; it does not appear in any official help-centre article I could
  locate, and in any case it would be a *display* preference, not documentation of the
  export. Treat as a weak prior, not evidence.

So the three candidate behaviours — **omit**, **retain unmarked**, **retain with
`PARTSTAT=DECLINED`** — cannot be discriminated from primary sources. Rank them for #88 to
check, in order of design impact:

1. **Retained with `PARTSTAT=DECLINED` on an identifiable owner `ATTENDEE`** → #90 becomes a
   real filter, and subscriber identity becomes the whole problem.
2. **Omitted from the feed** → #87's declined-drop requirement is already satisfied for
   Google and the filter is dead weight there (but still needed for Microsoft/Apple).
3. **Retained unmarked** (no `ATTENDEE`, or no `PARTSTAT`) → **the feed is inadequate** and
   no client-side rule can fix it; the map would need to reconsider (e.g. fall back to
   `TRANSP`, or accept the flash for Google).

Microsoft and Apple are even less documented. Microsoft's publish-a-calendar docs describe
only *detail levels* — availability-only vs. titles-and-locations vs. all-details ("HTML and
ICS calendars are read-only, so recipients won't be able to edit your calendar") — with no
statement about attendee lists or participation status at any level. Note that the
lower detail levels plausibly strip `ATTENDEE` altogether. Apple's iCloud calendar-sharing
documentation describes the sharing *mechanism* only and never specifies what event metadata
a public URL exposes; Apple's docs are the thinnest of the three.

---

## 6. `TRANSP`

RFC 5545 §3.8.2.7:

> Time Transparency is the characteristic of an event that determines whether it appears to
> consume time on a calendar. Events that consume actual time for the individual or resource
> associated with the calendar SHOULD be recorded as OPAQUE, allowing them to be detected by
> free/busy time searches. Other events, which do not take up the individual's (or
> resource's) time SHOULD be recorded as TRANSPARENT, making them invisible to free/busy time
> searches.

```
transvalue = "OPAQUE"
            ;Blocks or opaque on busy time searches.
            / "TRANSPARENT"
            ;Transparent on busy time searches.
;Default value is OPAQUE
```

Points for [#91](https://github.com/sigma/callctl/issues/91):

- **The default is `OPAQUE`**, so an absent `TRANSP` is a blocking event. A `TRANSPARENT`
  filter is therefore *safe by omission* — feeds that never emit `TRANSP` are unaffected.
- Note both clauses are **`SHOULD`**, not `MUST`. Transparency is advisory.
- It is a **free/busy** signal only. Its natural population is all-day birthdays, holidays,
  informational blocks — none of which carry a join link anyway, so **§6 tier-(c) filtering
  already drops most of them for free.** The marginal value of a `TRANSP` filter is
  restricted to the narrow set of *link-bearing but transparent* events.
- Conversely, real meetings **can** legitimately be transparent: a user who marks a call
  "Free" so it doesn't block their availability still intends to attend it. That is a real
  false-drop risk, and it cuts against filtering on `TRANSP` under the map's own asymmetry
  principle.
- Microsoft muddies this further by carrying *both* `TRANSP` and `X-MICROSOFT-CDO-BUSYSTATUS`
  (their `FREE`/`TENTATIVE`/`BUSY`/`OOF` axis is strictly richer than the RFC's binary), so
  the two can disagree — e.g. `TRANSP:OPAQUE` alongside `X-MICROSOFT-CDO-BUSYSTATUS:OOF`.

No primary source establishes that ordinary meetings are *mistakenly* marked transparent;
that would be a field observation, not a documented behaviour.

---

## 7. What node-ical actually gives us

Verified empirically against **`node-ical@0.27.1`** (the pinned version in
`packages/plugin/package.json`) by parsing a synthetic Google-shaped feed. Sources:
`lib/ical-parser-utils.js` (`storeParameter` / `storeValueParameter`) and `ical.js`
(`handleObject`).

### Property name mapping

| ICS property | node-ical key on the VEvent | Note |
| --- | --- | --- |
| `ATTENDEE` | `attendee` | lowercased |
| `ORGANIZER` | `organizer` | lowercased |
| `STATUS` | `status` | lowercased; plain string, **not** unwrapped-needed |
| `TRANSP` | **`transparency`** | ⚠️ **renamed**, not `transp` — explicit handler in `ical.js` |
| `RECURRENCE-ID` | `recurrenceid` | parsed to a `Date`, not a string |
| `EXDATE` | `exdate` | keyed map of dates |
| `X-MICROSOFT-CDO-BUSYSTATUS` | **`MICROSOFT-CDO-BUSYSTATUS`** | ⚠️ de-prefixed, **uppercase preserved** |
| `X-WR-CALNAME` (on VCALENDAR) | **`WR-CALNAME`** | ⚠️ same, and it lands on the `vcalendar` entry |

The `X-` rule, from `ical.js#handleObject`:

```js
if (/X-(?:\w|-)+/v.test(name) && stack.length > 0) {
  // Trimming the leading and perform storeParam
  name = name.slice(2);
  return storeParameter(name)(value, parameters, ctx, stack, line);
}

return storeParameter(name.toLowerCase())(value, parameters, ctx);
```

Note the asymmetry that bites: the `X-` branch calls `storeParameter(name)` with **no
`.toLowerCase()`**, while the fallback lowercases. So `X-` keys stay SCREAMING-KEBAB after
de-prefixing. This already matches `types.ts`'s `"GOOGLE-CONFERENCE"` and `"ALT-DESC"`
declarations — the same rule, now confirmed to extend to VCALENDAR-level `X-WR-*`.

### Shape of `attendee`

`storeParameter` returns `{params, val}` **only when the line carried parameters**,
otherwise a bare string; `storeValueParameter` promotes a repeated property to an array.
Since `ATTENDEE` essentially always carries at least `PARTSTAT` or `CN`, expect
`{params, val}` — but a bare-string `ATTENDEE:mailto:x@y` is legal and must not crash the
reader. Observed output for a two-attendee event:

```json
"attendee": [
  { "params": { "CUTYPE": "INDIVIDUAL", "ROLE": "REQ-PARTICIPANT",
                "PARTSTAT": "DECLINED", "CN": "Me", "X-NUM-GUESTS": 0 },
    "val": "mailto:me@example.com" },
  { "params": { "CUTYPE": "INDIVIDUAL", "ROLE": "REQ-PARTICIPANT",
                "PARTSTAT": "ACCEPTED", "CN": "Boss", "X-NUM-GUESTS": 0 },
    "val": "mailto:boss@example.com" }
]
```

and for a **single** attendee, an object rather than a one-element array:

```json
"attendee": { "params": { "PARTSTAT": "ACCEPTED" }, "val": "mailto:solo@example.com" }
```

Four things to design around:

- **`attendee` is object-or-array.** Unlike the §6.1 URL extraction, which "takes the first
  element", the attendance filter must scan **all** attendees to find the owner. A
  `toArray()`-style normalizer is needed; `types.ts`'s existing `IcalProperty` union covers
  the shape but its readers' first-element convention does not.
- **`params` keys keep their original case** (`PARTSTAT`, `CN`) and `X-` parameters are
  **not** de-prefixed inside `params` — `X-NUM-GUESTS` stays `X-NUM-GUESTS`. So a
  hypothetical `X-GOOGLE-SELF` parameter (§5) would appear verbatim. Values are
  best-effort coerced (`X-NUM-GUESTS` came back as the number `0`), so **compare
  case-insensitively and stringify defensively.**
- **`val` is a `mailto:` URI**, per the `CAL-ADDRESS` value type — matching against a
  configured email needs the scheme stripped and a case-insensitive compare (RFC 5545 does
  not normalize case for us).
- **`status` and `transparency` come back as bare strings** (`"CONFIRMED"`, `"CANCELLED"`,
  `"OPAQUE"`) with no `{params, val}` wrapper in practice — but they *can* be wrapped if a
  provider ever attaches a parameter, so route them through the existing unwrap helper in
  `engine.ts` rather than reading them raw.

### Recurrence overrides

A `RECURRENCE-ID` VEVENT with `STATUS:CANCELLED` parses into its own top-level entry
carrying `status: "CANCELLED"`, `recurrenceid: <Date>`, and a `recurrences` map. node-ical's
`expandRecurringEvent` (used by `engine.ts`) applies overrides, so the cancelled instance is
expected to be **generated with its override's `STATUS:CANCELLED` attached** — the filter
therefore needs to run on the *expanded occurrence*, not only on the master VEVENT. Worth a
targeted unit test in whichever ticket implements it; this is the one behaviour that could
silently no-op.

### Typings

`node-ical.d.ts` already models all of this — `AttendeePartStat`
(`'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'DELEGATED'`), `VEventStatus`
(`'TENTATIVE' | 'CONFIRMED' | 'CANCELLED'`), `Transparency`
(`'TRANSPARENT' | 'OPAQUE'`), and `Attendee = ParameterValue<string, {PARTSTAT?, CN?, …}>`.
If `ParsedEvent` in `types.ts` grows these fields, the union types can be lifted from there
rather than re-invented, though `types.ts`'s deliberate independence from node-ical argues
for redeclaring them locally.

---

## 8. Open questions for the live capture (#88)

Ordered by how much they change the design:

1. Does an owner-`ATTENDEE` line exist at all in a Google secret-address feed, and does it
   carry `PARTSTAT`? (§3, §5)
2. Is there any `X-` **parameter** on the owner's `ATTENDEE` marking it as "self"? (§5)
3. Is `X-WR-CALNAME` present, and for a primary personal calendar is it the owner's email?
   (§2)
4. Does the feed emit a `METHOD`, and if so which? (§3)
5. Is a declined event present at all, and with what `PARTSTAT` / `TRANSP` / `STATUS`? (§5)
6. Does a cancelled *occurrence* of a series appear as a `RECURRENCE-ID` +
   `STATUS:CANCELLED` override, as an `EXDATE`, or not at all? (§4)
7. Do any link-bearing events carry `TRANSP:TRANSPARENT`? (§6)

## Sources

- [RFC 5545 — Internet Calendaring and Scheduling Core Object Specification (iCalendar)](https://www.rfc-editor.org/rfc/rfc5545.txt) — §3.2.12 `PARTSTAT`, §3.7.2 `METHOD`, §3.8.1.11 `STATUS`, §3.8.2.7 `TRANSP`, §3.8.4.1 `ATTENDEE`, §3.8.4.3 `ORGANIZER`, §3.8.5.1 `EXDATE`
- [RFC 5546 — iCalendar Transport-Independent Interoperability Protocol (iTIP)](https://www.rfc-editor.org/rfc/rfc5546.txt) — §2.1.1, §3.2.1 `PUBLISH`, §3.2.3 `REPLY`, §3.2.5 `CANCEL`
- [RFC 7986 — New Properties for iCalendar](https://www.rfc-editor.org/rfc/rfc7986.html)
- [MS-OXCICAL: X-MICROSOFT-CDO-BUSYSTATUS](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/cd68eae7-ed65-4dd3-8ea7-ad585c76c736)
- [MS-OXCICAL: X-MICROSOFT-CDO-INTENDEDSTATUS](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/df1c7988-9908-4ee6-95b0-fcd180b02b44)
- [MS-OXCICAL: Attendee's Meeting Acceptance](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/703406b8-e8ed-4603-9b33-4994d09d60fd)
- [Google Calendar API v3 — Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [Google Calendar Help — Sync your calendar with computer programs](https://support.google.com/calendar/answer/37648)
- [Google Calendar Help — Export events from your Google Calendar](https://support.google.com/calendar/answer/37111)
- [Microsoft Support — Share your calendar in Outlook on the web](https://support.microsoft.com/en-us/office/share-your-calendar-in-outlook-on-the-web-7ecef8ae-139c-40d9-bae2-a23977ee58d5)
- [Microsoft Support — Introduction to publishing Internet calendars](https://support.microsoft.com/en-us/office/introduction-to-publishing-internet-calendars-a25e68d6-695a-41c6-a701-103d44ba151d)
- [Apple Support — Share a calendar in iCloud](https://support.apple.com/guide/icloud/share-a-calendar-mm6b1a9479/icloud)
- `node-ical@0.27.1` — `ical.js` (`handleObject`), `lib/ical-parser-utils.js` (`storeParameter`, `storeValueParameter`), `node-ical.d.ts`; behaviour confirmed by direct parse
