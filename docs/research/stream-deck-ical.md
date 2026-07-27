# stream-deck-ical — reference mining for the "Next Meeting" action

> Research asset for [Map #35](https://github.com/sigma/callctl/issues/35),
> ticket [#36](https://github.com/sigma/callctl/issues/36). AFK research —
> reference mining an MIT-licensed prior art, **not** a port.
> Primary source: the [`pedrofuentes/stream-deck-ical`](https://github.com/pedrofuentes/stream-deck-ical)
> repo at commit `82f2d25` (v2.4.5). All file citations below are permalinks of
> the form `.../blob/82f2d25.../<path>`. Read against the actual source files
> (package.json, manifest.json, `src/*`, `pi/*`), cross-checked with a repo-wide
> `gh search code` for URL-opening APIs.

## TL;DR for the spec

- **It is genuinely close prior art** — Node-side Stream Deck plugin, `ical.js`
  parser, `rrule` recurrence expansion, `luxon` + `windows-iana` timezones,
  polls a secret feed on a timer, renders a per-second countdown with an
  orange/red escalation, marquee title on tap. Almost every non-differentiating
  concept in our spec has a mature reference implementation here worth studying.
- **The headline gap is confirmed by reading the code, not inferring it**: the
  plugin **never opens a URL**. A repo-wide search for `openUrl`/`system.open`/
  `child_process`/`hangoutLink`/`conferenceData` returns **zero source hits**
  (only docs/fixtures). `onKeyUp` only shows the title marquee, cycles
  concurrent meetings, or force-refreshes — see [§8](#8-gaps-vs-our-destination).
- **It has no concept of a "join link" at all.** The `CalendarEvent` model
  ([`src/types/index.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/types/index.ts#L12-L27))
  carries `location`/`description` but never extracts or stores a conferencing
  URL, and "next event" selection has **no join-link filter** — it picks the
  next *chronological* event regardless of whether it can be joined.
- **Stack we should match**: `@elgato/streamdeck` **v2** (Node SDK, `SDKVersion: 3`
  manifest), TypeScript, rollup, vitest. This is the same SDK generation callctl's
  `@callctl/plugin` already uses — the plugin-side execution model transfers directly.
- **Directly reusable design ideas** (mine, don't copy): the fetch→parse→expand→
  filter→sort→cache pipeline, the `LOADED`/`NETWORK_ERROR`/… status-state machine
  with background-refresh-keeps-stale-data semantics, wall-clock RRULE expansion
  for DST correctness, configurable orange/red second thresholds, and the marquee
  algorithm.
- **License is MIT** — ideas are free; if we lift any *substantial verbatim code*
  we must carry its copyright + MIT text. Cleanroom reimplementation from these
  notes carries no attribution obligation. See [§7](#7-licensing).

## 1. iCal handling

**Parser: Mozilla `ical.js` (`^2.2.1`).** Not a regex parser — a real RFC 5545
tokenizer.
[`src/services/ical-parser.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/services/ical-parser.ts)
does `ICAL.parse` → `ICAL.Component` → iterate `vevent` subcomponents wrapped in
`ICAL.Event`. It also registers every `VTIMEZONE` with `ICAL.TimezoneService`
(L139-148) and detects the provider from `PRODID` (google/outlook/apple/unknown,
L20-29). (Aligns with the callctl global rule "don't build parsers on regex".)

**Fetch of secret feeds: plain `fetch()`, no auth layer.**
[`src/services/calendar-service.ts` `fetchICalFeed`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/services/calendar-service.ts#L54-L86):

- The **secret is the URL itself** (a private/secret iCal share link). There is
  **no** Authorization header, API key, or OAuth — the whole security model is
  "unguessable URL", stored in Stream Deck settings.
- One `GET` with `Accept: text/calendar, text/plain, */*`, a **30 s**
  `AbortController` timeout (`FETCH_TIMEOUT_MS`, L41), body read via
  `response.text()`.
- `webcal://` / `webcals://` share links are **rewritten to `https://`** before
  fetch (Node `fetch` can't dereference `webcal:`), and scheme is validated to
  http(s) up front —
  [`src/utils/url-utils.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/utils/url-utils.ts#L35-L69).
  Worth copying — Apple/iCloud links are `webcal:`.

**RRULE / EXDATE recurrence expansion: the `rrule` lib (`^2.8.1`), wall-clock
in the event's IANA zone.**
[`src/services/recurrence-expander.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/services/recurrence-expander.ts):

- `RRuleSet` holds the `RRULE` + `EXDATE`s together; `between(start,end)` yields
  occurrences within the window (L285-347).
- **DST-correct expansion is the hard-won part.** Instead of expanding in UTC,
  it converts DTSTART to a *fake-UTC "wall-clock" Date* in the event's zone,
  runs `rrule` there so `BYDAY`/weekly stepping follow the local calendar
  (issue #39), then converts occurrences back to real UTC and re-filters against
  the exact real-UTC window (L265-387). `UNTIL` is rewritten into the zone
  (L144-152); EXDATEs are matched both as wall-clock and exact real-UTC
  timestamps to survive spring-forward gaps (L361-377).
- **`RECURRENCE-ID` exception handling**: `processRecurringEvents` (L438-537)
  builds exact-UTC *and* date-only exception maps so a modified/cancelled single
  occurrence overrides its expanded twin even when DST shifts it ±1h (issue #27).
- **CPU guards** worth noting for us: `MAX_OCCURRENCES = 500` in-window cap plus
  a derived `MAX_RAW_OCCURRENCES` pre-cap enforced *during* generation via
  rrule's iterator callback, so a pathological `FREQ=SECONDLY` feed can't
  allocate hundreds of thousands of Dates (issue #26, L21-64, L341-347).

**Windows ↔ IANA timezone conversion: yes, via `windows-iana` (`^5.0.0`).**
[`src/services/timezone-service.ts` `parseTimezone`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/services/timezone-service.ts#L19-L56):
strips Outlook's quoted `TZID="Eastern Standard Time"`, detects a Windows zone
by the `/ Standard Time$| Daylight Time$/` suffix, and maps it to IANA via
`windowsiana.findIana()`. IANA validity is checked with `Intl.DateTimeFormat`
(L84-92). This matters because Outlook/Office 365 feeds emit Windows zone names
that `luxon` alone can't resolve.

## 2. Polling cadence & refresh behavior

[`src/services/calendar-service.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/services/calendar-service.ts)
+ [`src/plugin.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/plugin.ts):

- **Cadence: a fixed `setInterval` every 10 minutes** — `startPeriodicUpdates(url,
  window, updateIntervalMinutes = 10, …)` (L239-257), called from `plugin.ts`
  L140/199 with the literal `10`. **Not user-configurable** and **no backoff** —
  a failing feed is retried on the same 10-minute beat.
- **Caching**: a single in-memory `calendarCache` object (`{version, status,
  events, lastFetch, provider}`, L19-25). The multi-calendar path uses a
  per-URL `CalendarInstance` cache in `CalendarManager` (see §5). There is **no
  on-disk / HTTP cache** (no ETag/If-Modified-Since) — every poll refetches the
  whole feed.
- **Refresh semantics worth stealing** (L133-202): a **background** refresh
  (cache already `LOADED`/`NO_EVENTS`) stays silent and, **if it fails, keeps
  showing stale data**; only the *initial* load surfaces `LOADING` then a
  `NETWORK_ERROR`/`PARSE_ERROR`. A re-entrancy `isUpdating` flag drops
  overlapping polls (issue #26).
- **Display tick is separate from the fetch tick**: each button runs its own
  `setInterval(…, 1000)` to repaint the countdown from cache
  ([`base-action.ts` L785-819](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/base-action.ts#L785-L819)).
  So the network cadence (10 min) and the visual cadence (1 s) are decoupled —
  a pattern we want.
- **Manual refresh**: double-press a key → `forceRefreshCache()` (L315-324);
  the PI can also bump a `urlVersion` counter to force a refetch (`plugin.ts`
  L73-77).
- There's also an **orphan sweep** (`startOrphanSweep`, 60 s) that reaps leaked
  per-button timers after macOS wake-from-sleep re-emits `onWillAppear` without
  a matching `onWillDisappear` (issue #29) — a real Stream-Deck-on-Node footgun
  worth remembering, not core to our spec.

## 3. Rendering

**Countdown format** —
[`src/utils/time-utils.ts` `sec2time`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/utils/time-utils.ts#L14-L32):
collapses to the coarsest useful unit — `>1h` → `"2h"`, `1h+mins` → `"1h 30m"`,
`<1h` → `"45m 20s"`, `<1m` → `"15s"`. Negative durations get a `"- "` prefix
(used by Time-Left's overrun grace, not by Next-Meeting).

**Scrolling-title marquee** —
[`next-meeting-base.ts` `startMarquee`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/next-meeting-base.ts#L85-L126):
on tap it pads the title with `"  •  "`, then every **250 ms** emits a
**7-character** window sliding through the string with wrap-around
(`(pos + i) % paddedTitle.length`). Auto-stops after a configurable
`titleDisplayDuration` (default 15 s; options 5/10/15/30). Same routine is
duplicated in `combined-action-base.ts`. (`event-utils.ts` also has an unused
`trimForMarquee` helper.) Note: **the marquee shows the event *summary*, never a
link.**

**Warning-color model** — thresholds are **seconds** and **configurable**, held
in `GlobalSettings` as `orangeThreshold` (default **300 s / 5 min**) and
`redThreshold` (default **30 s**):

- Defaults + accessors:
  [`base-action.ts` L301-325](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/base-action.ts#L301-L325)
  (`DEFAULT_RED_ZONE = 30`, `DEFAULT_ORANGE_ZONE = 300`, overridden by
  `globalSettings.redThreshold`/`orangeThreshold`).
- Type home:
  [`types/index.ts` L109-112](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/types/index.ts#L109-L112).
- Applied in Next-Meeting:
  [`next-meeting-base.ts` L191-200](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/next-meeting-base.ts#L191-L200)
  — `≤ redZone` → `nextMeetingRed`, else `≤ orangeZone` → `nextMeetingOrange`,
  else `nextMeeting`.
- **Rendering is by swapping pre-baked PNG assets** (`assets/nextMeeting*.png`,
  `@resvg/resvg-js` is a dev-only asset build dep) via `action.setImage(...)`,
  plus `action.setTitle(...)` for the countdown text. **No canvas/SVG rendered at
  runtime.** The three color "states" are three images, not multi-state key
  states.
- **Escalation stops at start.** For Next-Meeting, once `secondsRemaining < 0`
  the code `return`s and lets the next tick move on — **there is no
  flashing-red-when-late state** for an upcoming meeting (see §8). The only flash
  is Time-Left's "a meeting just *started*" alert
  ([`base-action.ts` `flashButton` L981-1022](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/base-action.ts#L981-L1022);
  200 ms alternate images, gated by `flashOnMeetingStart`), and Time-Left has a
  5-minute post-end red grace period
  ([`time-left-base.ts` L141-165](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/time-left-base.ts#L141-L165)).

## 4. Config & the three action modes

**Three separate actions** (not one action with a mode dropdown) —
[`src/manifest.json` L3-46](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/manifest.json#L3-L46):

- **`…ical.timeleft` — "Time Left"**: shows time remaining in the *currently
  active* meeting (`findActiveEvents`, counts down `event.end`), cycles concurrent
  meetings on tap, red grace period after end
  ([`time-left-base.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/time-left-base.ts)).
- **`…ical.nextmeeting` — "Next Meeting"**: countdown to the *next upcoming*
  meeting's `start` (`findNextEvent`), title marquee on tap
  ([`next-meeting-base.ts`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/next-meeting-base.ts)).
- **`…ical.combined` — "Smart Calendar"**: shows Time-Left when a meeting is
  active, else Next-Meeting; switches mode automatically each tick
  ([`combined-action-base.ts` `updateDisplay` L157-195](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/combined-action-base.ts#L157-L195)).

**"Next event" selection** —
[`event-utils.ts` L46-57](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/utils/event-utils.ts#L46-L57):
`findNextEvent = events.filter(isUpcomingEvent)[0]` on the start-time-sorted
cache. **Purely chronological — no join-link filter, no attendee/status filter**
beyond the earlier all-day exclusion.

**Property Inspector shape** —
[`pi/pi.js`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/pi/pi.js)
+ a `setup.html` popup:

- The **per-button PI is deliberately minimal**: a single `<select id="calendarSelect">`
  that lets each key pick *which named calendar* to display, saved as
  `actionSettings.calendarId` (L251-263). A gear button opens `setup.html` for
  the heavy global config.
- It talks the **raw Stream Deck registration WebSocket protocol by hand**
  (`connectElgatoStreamDeckSocket`, `getGlobalSettings`/`setSettings` JSON frames,
  L26-149) rather than using `@elgato/streamdeck`'s PI SDK.
- **Named / multiple calendars**: `GlobalSettings.calendars: NamedCalendar[]`
  (`{id, name, url, timeWindow?, excludeAllDay?}`) with a `defaultCalendarId`
  ([`types/index.ts` L67-112](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/types/index.ts#L67-L112)).
  **Per-button assignment** is by `calendarId` on `ActionSettings`; the base
  action de-dupes calendars by URL via a `CalendarManager` with refcounts so N
  buttons on one feed share one poll loop
  ([`base-action.ts` L394-459](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/base-action.ts#L394-L459)).
  There's a legacy single-`url` migration path kept for backwards compat.
- **Global settings** also carry `timeWindow` (1/3/5/7 days), `excludeAllDay`,
  `titleDisplayDuration`, `flashOnMeetingStart`, and the two color thresholds.

## 5. Multi-calendar manager (bonus, relevant to per-button feeds)

`CalendarManager` ([`src/services/calendar-manager.ts`], 542 lines, not fully
inlined here) is the multi-feed evolution of the single global cache: it keys a
`CalendarInstance` per **unique URL**, refcounts how many buttons use it, runs one
poll loop per URL, and tears the instance down when the last button leaves. If our
"Next Meeting" supports *multiple* secret feeds, this refcount-per-URL model is the
reference to mine — though our spec's twist is *merging* feeds to find the next
joinable event, which it does not do (it's one-feed-per-button).

## 6. Stack & SDK version

- **Language/build**: TypeScript `^5.3`, ESM (`"type": "module"`), **rollup**
  bundler (`@rollup/plugin-typescript`, commonjs, node-resolve), **vitest** tests
  (with `happy-dom` for PI tests). `cross-env NODE_ENV` gates dev/prod builds.
  ([`package.json`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/package.json))
- **Stream Deck SDK**: **`@elgato/streamdeck` `^2.1.0`** — the **v2 / Node.js**
  generation (`SingletonAction`, `@action` decorators, `streamDeck.actions.
  registerAction`, `streamDeck.connect()`). Manifest is **`SDKVersion: 3`** with a
  `"Nodejs": { "Version": "20" }` block and `CodePath: bin/plugin.js`
  ([`src/manifest.json`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/manifest.json)).
  **This is the same SDK family `@callctl/plugin` already uses** — the execution
  model, action lifecycle, and settings plumbing transfer directly; callctl's
  plugin just additionally runs a WS server, which this plugin does not need.
- Dev tooling uses the `streamdeck` CLI (`streamdeck link/validate/pack`).
- A decorator quirk to note: each action splits into a decorator-free `*-base.ts`
  (imported by vitest, which chokes on the `@action` decorator under esbuild) plus
  a thin decorated leaf. If we test with vitest we may hit the same and can reuse
  this split.

## 7. Licensing

- **License: MIT** —
  [`LICENSE`](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/LICENSE),
  `"license": "MIT"` in package.json, and per-file
  `@license MIT` / `@copyright Pedro Pablo Fuentes Schuster` headers.
- **What we can borrow freely**: all the *ideas, algorithms, and architecture*
  documented here — pipeline shape, DST wall-clock expansion strategy, threshold
  model, marquee math, status state machine, refcount-per-URL manager. Facts and
  approaches are not copyrightable; a cleanroom reimplementation from these notes
  carries **no attribution obligation**.
- **The one constraint**: if we copy *substantial verbatim source* (a whole file
  or a distinctive function largely as-is), MIT requires we **retain the copyright
  notice and the MIT permission text** for that copied code. Given callctl is its
  own licensed monorepo, the clean path is **reimplement, don't paste** — then
  there's nothing to attribute. Its own runtime deps (`ical.js` MPL-2.0, `rrule`
  BSD-3, `luxon` Apache-2.0, `windows-iana` MIT) are ordinary npm deps we'd pull
  fresh anyway.

## 8. Gaps vs our destination

What stream-deck-ical does **not** do that ticket #36's "Next Meeting" spec
requires:

1. **Never opens the join URL (the headline differentiator — confirmed in code).**
   `onKeyUp` → `handleSinglePress` only toggles the **title marquee**
   ([`next-meeting-base.ts` L64-80](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/next-meeting-base.ts#L64-L80)),
   and double-press force-refreshes
   ([`base-action.ts` L722-780](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/base-action.ts#L722-L780)).
   A repo-wide `gh search code` for `openUrl`, `openURL`, `system.open`,
   `child_process`, `hangoutLink`, `conferenceData`, `X-GOOGLE-CONFERENCE`
   returned **no source hits** (only CONTRIBUTING.md / test fixtures). The press
   is a display toggle, never a launch. **This is our reason to exist.**
2. **No join-link extraction at all.** `CalendarEvent`
   ([`types/index.ts` L12-27](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/types/index.ts#L12-L27))
   has no URL field; the parser never mines `X-GOOGLE-CONFERENCE`, a Zoom/Meet
   URL out of `location`/`description`, or a `CONFERENCE`/`URL` property. We must
   add this parse step.
3. **No "next event *with a join link*" selection.** `findNextEvent` picks the
   next chronological event unconditionally. Our spec needs to **skip
   non-joinable events** and surface the next *joinable* one.
4. **No default-browser open** — no `streamDeck.system.openUrl(...)` (SDK v2 API)
   or equivalent. We add it.
5. **No escalation-past-start / flashing-late state for an upcoming meeting.**
   Next-Meeting stops updating once the meeting has started (`secondsRemaining < 0`
   → early `return`,
   [`next-meeting-base.ts` L183-188](https://github.com/pedrofuentes/stream-deck-ical/blob/82f2d25781295ab1e2792c8bc7ffaf4184b4ad6f/src/actions/next-meeting-base.ts#L183-L188)).
   The only "flash" is Time-Left's meeting-*started* alert and its post-end red
   grace, neither of which is "you are late to join, flashing red past T-0". We
   build the late-escalation ourselves.
6. **No multi-feed *merge*.** Calendars are isolated per button (one feed →
   one button); our spec wants to fetch several secret feeds and find the single
   next joinable event across all of them. The `CalendarManager` refcount model
   is reusable plumbing but does not merge event streams.
7. **Fixed 10-minute poll, no backoff, no HTTP caching (ETag/If-Modified-Since).**
   If we want a tighter/adaptive cadence or conditional requests, that's net-new.
8. **Rendering is pre-baked PNG state-swaps**, not runtime-drawn keys. If our
   escalation needs finer color/time granularity than three images, we'd render
   at runtime (canvas/SVG) — a different rendering path than theirs.

Non-gaps (things it *does* do well and we should mirror rather than reinvent):
secret-URL + `webcal:` fetch, `ical.js` parsing, DST-correct `rrule` expansion,
Windows→IANA zones, configurable second-thresholds, background-refresh-keeps-stale
semantics, decoupled fetch-tick vs display-tick, and the marquee.
