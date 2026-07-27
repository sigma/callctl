# Plugin-side iCal engine — fetch, parse, recurrence, next-event selection

> Research asset for [Map: Next-meeting deck button](https://github.com/sigma/callctl/issues/35),
> ticket [#38](https://github.com/sigma/callctl/issues/38). AFK research.
> Sources: npm registry API (`registry.npmjs.org`), the libraries' own GitHub
> READMEs, [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), Node.js v20 docs,
> and undici docs — cross-checked against the shipped plugin build
> (`packages/plugin`, Node 20, rollup + commonjs). See the Sources list.

## TL;DR for the spec

- **Library: `node-ical`.** One pure-JS, rollup-friendly, TypeScript-typed
  package that does everything this feature needs: named-property + arbitrary
  `X-` access (so `X-GOOGLE-CONFERENCE` is readable), **native DST-aware
  recurrence expansion** with EXDATE/RECURRENCE-ID overrides, and self-contained
  timezone data. As of **v0.27** its only runtime deps are `rrule-temporal` +
  `temporal-polyfill` (both pure JS) — **no separate `rrule` dependency, no
  native modules.** Alternative `ical.js` (Mozilla) is excellent but lower-level
  and needs you to register timezone data yourself; not worth the extra wiring
  here.
- **Fetch with global `fetch` yourself** (do *not* use node-ical's `fromURL`), so
  the plugin controls `webcal://`→`https://` rewriting, redirect follow, an
  `AbortSignal.timeout`, and conditional `ETag`/`If-None-Match` polling. Parse the
  fetched string with `ical.async.parseICS(text)`. The secret is **in the URL
  path** (a capability URL) — no `Authorization` header; treat the URL as a
  credential and never log it.
- **Next instance without materializing infinity:** expand each recurring event
  over a **bounded horizon** (now → now + ~400 days, enough to catch the next
  weekly/monthly/yearly occurrence) via `expandRecurringEvent(event, {from, to})`
  (or `event.rrule.between(...)` minus `exdate` plus `recurrences`), then merge
  with non-recurring events and take the earliest still-relevant instance that
  carries a join link.
- **Where it lives:** a new `packages/plugin/src/calendar/` module (feed fetch +
  parse + recurrence + selection, all UI-agnostic and unit-testable), consumed by
  a new stateful `NextMeetingAction` in `src/actions/`. It does **not** touch
  `MeetRemote`/the websocket — this path is Chrome-independent by design.

---

## 1. Library choice: `node-ical` vs `ical.js`

All figures from the npm registry API / GitHub, July 2026.

### node-ical — RECOMMENDED

- **Health:** v**0.27.1**, published 2026-07-21 (63 releases, actively
  maintained); ~235k downloads/week; Apache-2.0; repo `jens-maus/node-ical`.
- **Bundling:** `"type":"module"` with dual `exports` (`import`→`node-ical.js`,
  `require`→`node-ical.cjs`, `types`→`node-ical.d.ts`). **Pure JS, zero native
  deps** (runtime deps `rrule-temporal ^2`, `temporal-polyfill ^1`, both pure
  JS). Bundles cleanly under our rollup config
  (`nodeResolve({exportConditions:["node"]})` + `commonjs`).
- **Property access:** parses VEVENT into named fields — `summary`,
  `description`, `location`, `start`, `end`, `uid`, `status`, `rrule` — **and
  exposes arbitrary `X-` properties** including `X-GOOGLE-CONFERENCE`. All-day
  events carry a `dateOnly === true` flag; `start`/`end` are JS `Date`s with a
  non-enumerable `.tz` giving the original IANA zone. This directly supports the
  confirmed extraction premise (Meet in `X-GOOGLE-CONFERENCE`, Zoom in
  `LOCATION`); the cross-provider details are ticket
  [#37](https://github.com/sigma/callctl/issues/37)'s job.
- **Recurrence:** expands natively — no `rrule` package needed. Either
  `expandRecurringEvent(event, {from, to})` → sorted instances with
  `isFullDay`/`isOverride` metadata (EXDATE + RECURRENCE-ID overrides handled), or
  the lower-level `event.rrule.between(from,to)` then subtract `event.exdate` and
  apply `event.recurrences`. Both `exdate` and `recurrences` use a dual-key scheme
  (`YYYY-MM-DD` **and** full ISO) so all-day and timed exceptions both match.
- **Timezones/DST:** resolves TZID from VTIMEZONE; recurrences computed in the
  DTSTART zone with per-instance UTC-offset re-resolution → **DST-aware**. Ships a
  CLDR-derived `windowsZones.json` mapping Outlook/Windows zone names to IANA.
  Because v0.27 uses `temporal-polyfill`, it does **not** rely on the host having
  full ICU/tz data.
- **All-day/multi-day:** `dateOnly` flag; multi-day via start/end. (Historical
  gotcha: very old versions normalized all-day DTSTART to `00:00:00Z`; modern
  releases preserve the instant + zone.)
- **TypeScript:** bundled `node-ical.d.ts`.

### ical.js (Mozilla) — strong but lower-level

- v**2.2.1** (2025-08-08); ~368k downloads/week; MPL-2.0; **zero dependencies**,
  bundles very cleanly. `X-` properties fully accessible via the generic property
  API; all-day = `ICAL.Time.isDate`. Recurrence is first-class but **manual**
  (`RecurExpansion`/`RecurIterator` iterators you drive until you pass "now" —
  which is actually a nice fit for "next instance", see §2).
- **The catch:** "stock ical.js does not register any timezones" — you must load
  `ical.timezones.js` or `ICAL.TimezoneService.register(...)` unless every feed
  embeds its own VTIMEZONE. That's extra bundle weight + wiring node-ical gives
  us for free. Choose ical.js only if we later want maximum control / minimal
  footprint.

### Also-rans

- **`ical-expander`** (v3.2.0) — friendly `between(after,before)` wrapper over
  ical.js, but **pinned to the old `ical.js ^1.2.2`**. Skip.
- **`rrule`** (jkbrzt, v2.8.1, last release 2023-11) — the de-facto RRULE engine,
  but it's not a parser and is **redundant with node-ical** here. Its returned
  "UTC" dates also don't materialize offset info, needing a Luxon conversion for
  true instants — another reason to let node-ical own recurrence.

**Verdict:** node-ical is the only option that in one pure-JS, rollup-friendly,
typed package covers named + `X-` property access, native DST-aware recurrence
with EXDATE/overrides, and self-contained timezones. Recommend it.

---

## 2. Expanding RRULE/EXDATE to the true *next* instance

### RFC 5545 facts

- **RRULE** (§3.8.5.3; RECUR value type §3.3.10): `FREQ` (required),
  `INTERVAL` (default 1), `COUNT`, `UNTIL` (inclusive), `BYDAY` (with optional
  ±ordinal, e.g. `-1SU`), `BYMONTHDAY`, `BYMONTH`, `WKST`. **`UNTIL` and `COUNT`
  MUST NOT both appear.**
- **`DTSTART` is always the first occurrence and the recurrence anchor** — it
  fixes the value type (DATE vs DATE-TIME) and TZID for the whole series.
- **EXDATE** (§3.8.5.1) excludes instances; **RDATE** (§3.8.5.2) adds them;
  **RECURRENCE-ID** overrides a single instance.
- **DATE vs DATE-TIME** (§3.3.4/§3.3.5): `VALUE=DATE` is an all-day event with no
  time; a TZID-qualified DATE-TIME is a specific instant.

### Getting only the next occurrence `>= now`

- **node-ical (our choice):** its API is range-based, so use a **bounded
  horizon** rather than an open-ended "next". `expandRecurringEvent(event,
  {from: now, to: now + ~400d})` returns sorted instances (EXDATE + overrides
  applied); take the first. A ~400-day window guarantees catching the next
  weekly/monthly/yearly instance while never touching an infinite series.
- (For reference, `ical.js` `RecurExpansion.next()` and `rrule.js`
  `RRuleSet.after(now)` both yield exactly the next instance without
  materializing the series — either would work if we ever switch engines.)

### Instance semantics to preserve

- Keep the **all-day flag** (`dateOnly`/`isFullDay`) through the pipeline:
  compare all-day instances on **calendar date** (local day), timed instances on
  **true instant**, so an all-day event doesn't mis-sort against timed ones.
- **DST correctness** falls out of anchoring expansion to the DTSTART zone and
  re-resolving the offset per instance (a "09:00 America/Los_Angeles" weekly event
  stays at local 09:00 across the spring/fall transition). node-ical does this.

---

## 3. Fetching a secret feed over HTTP in Node 20

- **Global `fetch`:** present in Node 20 on undici, **no flag required** (it
  stopped needing `--experimental-fetch` back in v18). The v20 docs still label it
  *Stability 1 – Experimental* (promoted to Stable in v21), but it works out of the
  box. `AbortController`/`AbortSignal` are fully stable.
- **`webcal://`:** a non-standard scheme fetch will not understand. **String-
  rewrite `webcal://`→`https://` (and `webcals://`→`https://`)** before fetching;
  host+path are otherwise identical. Apple/Google "subscribe" links use it.
- **Redirects:** `redirect` defaults to `"follow"`, which handles the `302`s that
  Google/Apple/Outlook secret feeds commonly return — no extra work.
- **Auth = capability URL:** the token lives **in the path** (Google
  `.../private-<token>/basic.ics`, Apple random host+path, Outlook `.../<guid>/`),
  there is **no `Authorization` header**. Treat the URL as a secret credential:
  store it securely, never log it, rely on TLS.
- **Timeouts:** always set one — pass `{ signal: AbortSignal.timeout(ms) }`;
  fetch rejects with `AbortError` on trigger.
- **Body/charset:** feeds are `text/calendar` (sometimes `application/octet-
  stream`); RFC 5545 mandates UTF-8. Read with `await res.text()` and hand the
  string to node-ical; undici decompresses gzip transparently. Don't trust the
  extension/content-type.
- **Caching / polling cadence:** hosts generally return `ETag`/`Last-Modified`,
  so send `If-None-Match`/`If-Modified-Since` on refresh and treat **`304 Not
  Modified`** as "reuse cached parse" — the polite, cheap pattern. Feeds change
  slowly and Google caches aggressively server-side, so tight polling is wasteful;
  a **~5–15 min refresh** (never tighter than ~1 min), backing off on errors, is
  ample for "next upcoming event". Exact cadence + freshness policy is decision
  ticket [#41](https://github.com/sigma/callctl/issues/41)'s call — this only
  establishes the mechanism (conditional GET) it can build on.

---

## 4. Selecting "the next event that has a link"

The selection pipeline, given one or more feeds:

1. **Parse** every feed → VEVENTs (`ical.async.parseICS`).
2. **Expand** each recurring event over `[now, now+~400d]` (§2); pass
   non-recurring events through as single instances. Result: a flat list of
   concrete `{start, end, allDay, joinUrl?, title, sourceFeed}` instances.
3. **Filter to link-bearing instances** — keep only those with a join URL
   (extraction rule per ticket [#37](https://github.com/sigma/callctl/issues/37):
   `X-GOOGLE-CONFERENCE`, then a URL in `LOCATION`, etc.). This enforces the
   map's locked scope: *only events that have a join link.*
4. **Sort by start**, then pick the target.

**Which one is "next" given overlapping/concurrent events?** The button exists to
get you into the meeting you're about to (or should already) be in, and the
escalation model "flashes red when late" — so the target is the **most imminent
still-relevant** instance, not merely the soonest-starting future one:

- Prefer the instance with the **earliest `start` whose `end` is still in the
  future** (`end > now`). This naturally selects a meeting you're currently inside
  (start ≤ now < end) over a later one, and lets the "start passed → flashing red"
  state be reached instead of the event silently disappearing at its start.
- **Ties / true overlaps** (two link-bearing meetings running at once): break by
  earliest `start`, then earliest `end` (the one ending soonest is the more
  urgent), then a stable key (uid) for determinism.
- **All-day link events** (rare) sort by calendar day and should rank **below** a
  timed meeting on the same day, since a timed start is the actionable moment.

Two boundaries this research surfaces but **defers** to the display/behavior
tickets, because they're UX decisions, not engine facts:

- **Hand-off point:** when does a just-ended meeting stop being the target and the
  next one take over — exactly at `end`, or a grace window after? → ticket
  [#41](https://github.com/sigma/callctl/issues/41) (meeting-boundary behavior).
- **How far ahead** the countdown starts caring / whether a far-future next
  meeting is shown at all vs. a blank key → ticket
  [#39](https://github.com/sigma/callctl/issues/39) (display + escalation).

The engine's contract is therefore: *given `now`, return the ordered list of
link-bearing instances (or the single chosen target) with their start/end and
join URL* — leaving "when does late become too late" to the behavior tickets.

---

## 5. Where this lives in `packages/plugin`

Current structure: `src/plugin.ts` (entry — builds actions, starts
`MeetRemote`), `src/actions/` (`index.ts` = single source of truth for the action
set; `SimpleAction` stateless press; `ToggleAction` three-state LED bound to
`MeetRemote`), `src/remote/` (the websocket server to the extension). Build =
rollup → one ESM file at `bin/plugin.js`; runtime Node 20; manifest is
hand-maintained with a matching `Actions[]` entry per UUID.

Proposed placement:

- **`src/calendar/` — the engine (new, UI-agnostic, unit-testable).** Feed
  fetch (`webcal` rewrite, conditional GET, timeout), parse (node-ical), recurrence
  expansion, and the §4 selection. Pure functions over `now` + feed URLs → chosen
  instance(s); **no Stream Deck or DOM types**, so it's vitest-friendly the way
  `meet-remote.test.ts` already tests `src/remote/` in isolation. This is
  deliberately parallel to `src/remote/` (a self-contained subsystem), **not**
  folded into it — the calendar path never touches the websocket/Meet, matching
  the map's "works with Chrome closed" premise and the repo's platform-code
  separation.
- **`src/actions/next-meeting-action.ts` — a new stateful action.** Neither
  `SimpleAction` (stateless) nor `ToggleAction` (3-state LED mirror) fits: this
  action owns a **timer** that re-renders the key (countdown + escalation, ticket
  [#39](https://github.com/sigma/callctl/issues/39)) and on press opens the join
  URL (ticket [#40](https://github.com/sigma/callctl/issues/40)). It follows the
  same "set `manifestId` per instance" pattern the existing actions use, is
  registered from `buildActions()` in `src/actions/index.ts`, and reads its
  secret-feed config from the action's Property Inspector settings (config UX =
  ticket [#42](https://github.com/sigma/callctl/issues/42)).
- **Dependency:** add `node-ical` to `packages/plugin/package.json`
  `dependencies`; it bundles under the existing rollup pipeline with no config
  change. No new manifest capability is needed for outbound HTTPS.

This keeps the wire/DOM path (`MeetRemote` ⇄ extension) completely untouched and
adds the calendar feature as a sibling subsystem plus one new action — no
existing action or the remote server changes.

---

## Sources

- node-ical — https://github.com/jens-maus/node-ical ·
  https://registry.npmjs.org/node-ical (v0.27.1, 2026-07-21) ·
  README (recurrence/exdate/overrides/all-day/`X-` props)
- ICAL.js (Mozilla) — https://github.com/kewisch/ical.js/ ·
  https://registry.npmjs.org/ical.js (v2.2.1, zero deps) ·
  https://kewisch.github.io/ical.js/api/
- ical-expander — https://www.npmjs.com/package/ical-expander (v3.2.0, deps
  `ical.js ^1.2.2`)
- rrule (jkbrzt) — https://github.com/jkbrzt/rrule ·
  https://registry.npmjs.org/rrule (v2.8.1, 2023-11-10)
- rrule-temporal — https://registry.npmjs.org/rrule-temporal
- RFC 5545 (iCalendar) — https://www.rfc-editor.org/rfc/rfc5545 (RRULE §3.8.5.3 /
  RECUR §3.3.10, EXDATE §3.8.5.1, RDATE §3.8.5.2, DATE §3.3.4)
- Node.js v20 globals (fetch stability, AbortController) —
  https://nodejs.org/docs/latest-v20.x/api/globals.html
- undici — https://undici.nodejs.org/
