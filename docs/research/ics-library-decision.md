# ICS library decision: reconciling node-ical vs ical.js

> Resolves wayfinder ticket [#47](https://github.com/sigma/callctl/issues/47).
> Two earlier research tickets reached **opposite** recommendations for the
> plugin-side "Next Meeting" parsing layer:
> [#38 (engine)](https://github.com/sigma/callctl/issues/38) picked **`node-ical`**,
> [#37 (join-URL extraction)](https://github.com/sigma/callctl/issues/37) picked
> **`ical.js`** — on the grounds that *"`node-ical` strips the `X-` prefix, so
> `X-GOOGLE-CONFERENCE` isn't faithfully readable."* This asset settles it
> **empirically** (both libraries run against real feeds; results below).
>
> Versions tested: **`node-ical` 0.27.1**, **`ical.js` 2.2.1** on Node 24.
> AFK research; reproducible from the probe scripts described in §5.

## TL;DR — decision

**Use `node-ical` as the single library for BOTH the engine and join-URL
extraction.** One parse pass, one dependency, one parsing story.

The conflict that split #37 and #38 was a **key-naming misunderstanding, not a real
capability gap.** `node-ical` *does* strip the leading `X-` — but it does so
**systematically and predictably**, and the value is **not lost**: it is reachable
under the de-prefixed key. So `X-GOOGLE-CONFERENCE` is read as `GOOGLE-CONFERENCE`.
#37's stated reason to reject `node-ical` ("not faithfully readable") is
**overturned**: the *value* is faithfully readable, just under a renamed —
mechanically derivable — key. And for Google Meet specifically the URL is **also
mirrored into `LOCATION`** (precedence rung 2), a second independent backstop.

Meanwhile `node-ical` wins **decisively** on the axis that actually carries risk —
timezone correctness — because it ships **self-contained tz data**, whereas `ical.js`
v2 ships **no bundled timezone dataset at all** and silently returns a **wrong**
instant for any feed that references a `TZID` without embedding its `VTIMEZONE`.

The cost of this choice is small and mechanical: the extraction rules from #37
(written against `ical.js`'s `x-google-conference` / `x-alt-desc` keys) must be
re-expressed for `node-ical`'s de-prefixed keys and its `{params, val}` shape for
parametrized properties. §4 specifies exactly how.

## 1. The empirical results

All four probes ran against the same fixtures (a realistic Google-Meet weekly-standup
feed with `VTIMEZONE`, `RRULE`, `EXDATE` straddling the 2026-03-08 US spring-forward;
plus a bare-`TZID`-no-`VTIMEZONE` feed; plus a Teams feed with `X-ALT-DESC`).

### 1a. `X-GOOGLE-CONFERENCE` readability

| Library | Access | Result |
|---|---|---|
| **node-ical** | `event['X-GOOGLE-CONFERENCE']` | **`undefined`** — prefix stripped |
| **node-ical** | `event['GOOGLE-CONFERENCE']` | ✅ `https://meet.google.com/abc-defg-hij` |
| **ical.js** | `vevent.getFirstPropertyValue('x-google-conference')` | ✅ `https://meet.google.com/abc-defg-hij` — full name preserved |

**Both libraries can read the Meet URL.** `node-ical` renames the key by dropping
`X-`; `ical.js` keeps the full lowercased name. The stripping is **systematic** — in
the same fixture `X-MICROSOFT-CDO-BUSYSTATUS` → `MICROSOFT-CDO-BUSYSTATUS` and
`X-ALT-DESC` → `ALT-DESC`. So the rename is a pure, predictable transform
(`key.replace(/^X-/i, '')`), not lossy or ambiguous. (No standard property collides
with a de-prefixed `X-` name in the join-URL chain.)

### 1b. Recurrence + DST correctness (weekly Monday 09:00 America/New_York)

Expected true instants: Mar 2 = 14:00 UTC (EST −05:00), Mar 9 = 13:00 UTC (EDT
−04:00, *after* spring-forward — must stay at local 09:00), Mar 16 = **excluded by
`EXDATE`**, Mar 23 = 13:00 UTC.

| Library | Mar 2 | Mar 9 | Mar 16 | Mar 23 | Verdict |
|---|---|---|---|---|---|
| **node-ical** (`rrule.between` + `exdate`) | 14:00Z | 13:00Z | excluded | 13:00Z | ✅ DST-correct, EXDATE honored |
| **ical.js** (`Event.iterator()`, VTIMEZONE registered) | 14:00Z | 13:00Z | excluded | 13:00Z | ✅ DST-correct, EXDATE auto-excluded |

**When the feed embeds `VTIMEZONE` (Google feeds do), both are fully correct.**
`ical.js` needs ~4 lines to register the embedded `VTIMEZONE` components first; then
its iterator resolves DST and auto-skips `EXDATE`. `node-ical` needs no setup.

### 1c. The decisive case — bare `TZID`, **no** embedded `VTIMEZONE`

`DTSTART;TZID=America/New_York:20260309T090000`, no `VTIMEZONE` in the feed:

| Library | Resolved instant | Zone | Correct? |
|---|---|---|---|
| **node-ical** | `2026-03-09T13:00:00Z` | `America/New_York` | ✅ correct (09:00 EDT) — self-contained tz data |
| **ical.js**, no registration | `2026-03-09T08:00:00Z` | **`floating`** | ❌ **wrong** — TZID unresolved, off by the offset |

This is exactly the failure mode #38 warned about, now confirmed. `ical.js` cannot
resolve a `TZID` it hasn't been given zone data for, and silently falls back to a
**floating** time — a wrong instant, not an error. `node-ical` resolves it for free.

### 1d. `ical.js` v2 ships no bundled timezone dataset

#38 assumed the mitigation was to load `ical.timezones.js`. **That file does not
exist in the `ical.js` v2 npm package** (`require.resolve('ical.js/dist/ical.timezones.js')`
→ *not found*; the package ships `timezone.js` / `timezone_service.js` code but no zone
*data*). It was a separately-distributed artifact in v1. So on v2, fixing 1c means
sourcing tz data yourself (generate from IANA tzdata, or add a third-party zone
package, or depend on every feed embedding `VTIMEZONE`). The registration burden is
therefore *heavier* than #38 estimated, not lighter.

## 2. Why `node-ical` — the decision rationale

1. **The extraction objection is void.** #37 rejected `node-ical` because
   `X-GOOGLE-CONFERENCE` "isn't faithfully readable." Empirically the *value* is
   faithfully readable under `GOOGLE-CONFERENCE` (§1a), and for Meet it is also in
   `LOCATION` (§1b fixture, and #37's own precedence rung 2). The join URL is never
   lost with `node-ical`.
2. **Timezone robustness is the real risk axis, and `node-ical` owns it.** A
   countdown that opens a meeting is worthless if it fires at the wrong minute. §1c
   shows `ical.js` silently yields a wrong instant for any `VTIMEZONE`-less feed, and
   §1d shows v2 gives you no bundled fix. `node-ical`'s self-contained data makes the
   common case correct with zero wiring and the edge case correct anyway.
3. **Native recurrence, zero extra deps.** `node-ical` expands `RRULE`/`EXDATE`/
   `RECURRENCE-ID` overrides itself (§1b), DST-correct. No `rrule` companion package.
4. **One library = one parsing story.** The engine and the extractor share one parse
   of each `VEVENT` — one dependency, one API, one mental model. This is the spec's
   explicit goal ("one coherent parsing layer"). A two-library split (node-ical for
   recurrence + ical.js for extraction) would mean two parse passes over the same
   bytes and two bundled deps to buy back only the cosmetic `X-` prefix — not worth
   it (§3).

### What `ical.js` does better (and why it still loses here)

`ical.js` preserves the literal `X-` prefix and is lower-level / more controllable,
with a lazy `next()` iterator instead of range expansion. Genuine strengths — but
they buy nothing this feature needs. We don't need the literal prefix (the value is
what we open), and the control comes at the price of the tz-data wiring that
`node-ical` hands us for free. For *this* use case `ical.js` is strictly more work
for a worse-in-the-edge-case result.

## 3. The rejected alternative: two libraries running together

Considered and dropped: `node-ical` for the engine + `ical.js` purely to read
`x-google-conference` with its prefix intact. Rejected because —

- It buys back only a **cosmetic key name**; the value is already reachable via
  `node-ical` (§1a) and via `LOCATION` (§1b).
- It forces **two parse passes** over identical `.ics` bytes and **two bundled deps**
  in the plugin.
- It splits the "one parsing story" the spec asked for across two APIs.

No functional capability is gained. Single-library node-ical wins.

## 4. Adapting #37's extraction chain to `node-ical` key naming

#37's precedence chain and `hasJoinLink` predicate stand unchanged in **logic**. Only
the **property lookups** change, because `node-ical` de-prefixes `X-` keys and wraps
parametrized properties. Concretely, for a `node-ical` `VEVENT` object `ev`:

| #37 rung (ical.js key) | node-ical access | Notes |
|---|---|---|
| `X-GOOGLE-CONFERENCE` | `ev['GOOGLE-CONFERENCE']` | `X-` stripped; plain string when no params |
| `LOCATION` | `ev.location` | plain string; Meet mirrors the URL here too |
| `DESCRIPTION` | `ev.description` | plain string; scan for embedded URL |
| `X-ALT-DESC` (Teams HTML) | `ev['ALT-DESC']` | **`{params, val}`** shape when `FMTTYPE` present → read `.val` |
| `URL` | `ev.url` | plain string |

Rules for the adapter:

- **De-prefix rule:** any `X-*` property from #37 becomes its de-prefixed key
  (`key.replace(/^X-/i, '')`, upper-case). Applied to `X-GOOGLE-CONFERENCE`,
  `X-ALT-DESC`.
- **Params unwrap:** a property carrying parameters (e.g. `X-ALT-DESC;FMTTYPE=text/html`)
  is returned by `node-ical` as `{ params: {...}, val: "<value>" }`, **not** a bare
  string. The extractor must read `.val` (a small `typeof v === 'string' ? v : v.val`
  helper). Properties without params (`GOOGLE-CONFERENCE`, `location`, `description`,
  `url`) come back as plain strings.
- Everything else in #37 is unchanged: the `isJoinUrl` predicate, the known-host
  preference for disambiguating multiple embedded URLs, and reading the parser's
  **unfolded** value rather than regexing raw `.ics`.

## 5. Reproducing

Probes: (1) parse the Meet feed and enumerate `VEVENT` keys + look up
`X-GOOGLE-CONFERENCE` under several spellings; (2) `ev.rrule.between(from,to)` minus
`ev.exdate` across the DST boundary; (3) the same event in `ical.js` via
`new ICAL.Event(vevent).iterator()` after registering embedded `VTIMEZONE`s;
(4) the bare-`TZID` feed through both libraries with no registration. Fixtures: a
Google weekly-standup `.ics` (VTIMEZONE + RRULE `FREQ=WEEKLY;BYDAY=MO` + `EXDATE`
2026-03-16), a bare-TZID variant, and a Teams `.ics` with `X-ALT-DESC`. All results
in §1.

## Sources

- [`node-ical` 0.27.1](https://github.com/jens-maus/node-ical) — behavior verified by
  execution (X- stripping, `{params,val}` wrapping, `rrule`/`exdate`, self-contained
  tz).
- [`ical.js` 2.2.1](https://github.com/kewisch/ical.js) — behavior verified by
  execution (full-name property access, `RecurExpansion` iterator, `floating`
  fallback for unregistered TZID, absence of bundled zone data in v2).
- RFC 5545 §3.8.8.2 (non-standard `X-` properties), §3.1 (line folding) — as cited in
  the #37 asset.
- Supersedes the library-choice sections of the #37 and #38 assets on the points
  above; their extraction *logic* (#37) and fetch/selection *design* (#38) stand.
</content>
</invoke>
