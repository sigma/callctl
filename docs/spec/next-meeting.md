# Spec: "Next Meeting" deck button

**Status:** implementable handoff spec — ready to build.
**Origin:** wayfinder map [Map: Next-meeting deck button](https://github.com/sigma/callctl/issues/35) (#35). This document is the synthesis deliverable of [Assemble the final Next-Meeting handoff spec](https://github.com/sigma/callctl/issues/53) (#53). It stitches together already-made decisions (#36–#52); it does **not** introduce new ones. Every non-trivial claim traces back to a closed ticket — see [§13 Traceability](#13-traceability).

---

## 1. Overview

A new callctl Stream Deck plugin action — **`NextMeetingAction`** — that runs **entirely plugin-side** (Node, no browser required, works with Chrome closed):

1. Fetches one or more **secret iCal feeds** over HTTP.
2. Finds the **next event that carries a join link**.
3. Renders a **countdown** on the key that **escalates** as start approaches and passes (→ flashing red when late).
4. On **press, opens the join URL** in a browser (default browser, or a configured Chromium profile).

The headline feature versus prior art ([stream-deck-ical](https://github.com/pedrofuentes/stream-deck-ical), MIT): **it opens the meeting**. That project never does.

### Locked premises (do not re-litigate)

- **Data source = secret iCal feed** (per-provider capability URL), *not* Google Calendar API / OAuth. Empirically confirmed the feed carries the join URL (Meet in `X-GOOGLE-CONFERENCE`, Zoom in `LOCATION`).
- **Logic runs in the plugin (Node).** Meet DOM is **not driven** — no auto-join, no DOM clicks. The extension contributes **only** an optional read-only join-detection signal (§10).
- **Event scope = only events that have a join link.** Linkless events are never surfaced.
- **Click = open the join URL** — you join yourself.

---

## 2. Architecture & placement

New code lives in `packages/plugin`:

```
packages/plugin/
  src/
    calendar/                 # NEW — UI-agnostic engine (fetch, parse, recurrence, extract, select)
      fetch.ts                #   conditional-GET HTTP + webcal rewrite
      engine.ts               #   parse + recurrence expansion + ordered selection
      extract.ts              #   join-URL extraction + canonicalization + tier classification (§6)
      types.ts
    actions/
      next-meeting-action.ts  # NEW — stateful action: timers, render, press-to-open
      index.ts                # register NextMeetingAction in buildActions()
    remote/
      meet-remote.ts          # MODIFIED — cache joinedKey from new callState event (§10)
  dev.yrh.callctl.sdPlugin/
    ui/next-meeting.html       # NEW — Property Inspector (§11)
  package.json                 # add "node-ical" dependency
```

- `src/calendar/` is a pure library (no Stream Deck imports) so it is vitest-testable in jsdom-free node context, mirroring `src/remote/`.
- `NextMeetingAction` is a new stateful action owning its render + poll timers, registered from `buildActions()` in `src/actions/index.ts`. It follows the existing `SimpleAction`/`ToggleAction` patterns but is neither — it is a countdown action.
- **`MeetRemote` / the websocket bridge is otherwise untouched.** The only change is caching the new `callState` input (§10). Next-Meeting does not require the extension to function.
- **Protocol change** (`@callctl/protocol`): add one `StateEvent` member (§10). That is the whole wire-contract delta.

### Dependencies

- Add **`node-ical`** (tested `0.27.1`) to `packages/plugin/package.json`. Pure JS, zero native deps; bundles under the existing rollup config with `nodeResolve({ exportConditions: ["node"] })` + commonjs. Transitive runtime deps: `rrule-temporal ^2`, `temporal-polyfill ^1`.
- HTTP uses Node 20's global `fetch` (undici) — **no** extra dependency, no flag.
- Open uses `@elgato/streamdeck` v2's `streamDeck.system.openUrl` (default path) and Node's `child_process.execFile` (configured-profile path). No new deps for either.

---

## 3. Data model & settings schema

Single source of truth for what the Property Inspector reads/writes and what the action consumes.

### Global settings (plugin-wide)

```ts
interface GlobalSettings {
  feeds: NamedFeed[];
  pollIntervalMinutes: number;   // default 15  (#41)
}

interface NamedFeed {
  id: string;                    // stable generated slug/uuid — survives renames
  name: string;                  // human label shown in the per-key dropdown
  url: string;                   // secret capability URL, stored PLAINTEXT (see §12)
  open?: {                       // optional per-feed browser-profile targeting (#51)
    browser: "chrome" | "chromium" | "edge" | "brave";
    profile: string;             // literal --profile-directory folder name, e.g. "Profile 1"
  };
}
```

- **The secret lives only in `GlobalSettings.feeds[].url`.** Global settings are excluded from `.streamDeckProfile` exports, so the secret never rides along in a shared profile.
- `id` is a stable generated slug so renaming a feed does not break per-key references.

### Per-key action settings

```ts
interface NextMeetingSettings {
  feedId: string;                // which global feed this key tracks (no cross-feed merge)
  offset: number;                // index into the ordered event list; default 0  (#41)
  graceMinutes: number;          // late-state dismissal grace; default 10  (#48)
}
```

- Per-key settings **never** contain the secret URL — only `feedId`. This keeps credentials out of shareable profile exports.
- `offset 0` = current/next event; `offset 1` = the one after; enables the planned "two buttons per calendar" (two keys re-index the same feed's ordered list and shift together at boundaries).
- A key whose `feedId` is empty, or points at a **deleted** feed, is treated as unconfigured → the no-feed setup prompt (§8).

---

## 4. iCal fetch

Fetch is done by hand (not `node-ical`'s `fromURL`) to control caching, rewriting, timeouts, and secret handling.

- **Library:** parse with `ical.async.parseICS(text)` (`node-ical`). Do **not** use `fromURL`.
- **Scheme rewrite:** rewrite `webcal://` → `https://` **and** `webcals://` → `https://` before fetching. Reject anything that is not `http(s)` after rewrite.
- **Secret handling:** the secret is in the **URL path** (capability URL). Send **no** `Authorization` header. **Never log the URL** — not in success paths, not in error paths.
- **Redirects:** default `redirect: "follow"` (feeds commonly 302).
- **Timeout:** `fetch(url, { signal: AbortSignal.timeout(ms) })`; a timeout rejects with `AbortError` — handle it as a poll failure (§9), never a crash.
- **Body:** `await res.text()`. Content-Type is usually `text/calendar`, sometimes `application/octet-stream`; UTF-8; undici transparently decompresses gzip.

### Conditional GET (freshness)

- Persist the last `ETag` and `Last-Modified` per feed. On each poll send `If-None-Match` (stored ETag) and `If-Modified-Since` (stored Last-Modified) when present. **Prefer ETag** if the server offered both.
- `304 Not Modified` → **reuse** the cached parsed event set; do not re-fetch body, do not re-parse.
- `200` → re-parse and **atomically swap** the in-memory event set.
- If the server offers no validator, fall back to a plain full `GET` each poll + re-parse.

---

## 5. Parse, recurrence & selection

### Parse

`node-ical` exposes named fields on each `VEVENT`: `summary`, `description`, `location`, `start`, `end`, `uid`, `status`, `rrule`. `start`/`end` are JS `Date` objects with a non-enumerable `.tz` (IANA zone). All-day events carry `dateOnly === true`.

### Recurrence expansion

- Use `node-ical`'s native recurrence: `expandRecurringEvent(event, { from, to })` returns sorted instances with `isFullDay` / `isOverride` metadata (EXDATE and RECURRENCE-ID overrides handled). Lower-level `event.rrule.between(from, to)` minus `event.exdate` plus `event.recurrences` is equivalent. Note `exdate`/`recurrences` use a dual-key scheme (`YYYY-MM-DD` **and** full ISO).
- **Bounded horizon:** expand only over `[now, now + ~400 days]`. Never materialize an unbounded series.
- **Missing `DTEND`:** synthesize `end = start + 30 min`.
- **DST correctness comes from `node-ical`.** It self-contains timezone data, so a bare `TZID` with no embedded `VTIMEZONE` still resolves correctly (this is the decisive reason it was chosen over `ical.js` — see §6 note and #47). A recurring "9:00 America/New_York" stays 9:00 local across the spring-forward boundary.

### Selection → ordered list

The engine returns an **ordered list** of upcoming, still-relevant, **link-bearing** event instances (not a single event) — a key selects one by its `offset`.

1. Expand recurrences over the horizon.
2. Filter to instances that yield a join candidate (extraction, §6 — tiers (a) and (b) both count as "has a link"; tier (c) is excluded).
3. Keep instances whose `end > now`.
4. **Sort:** `start` ascending → then `end` ascending → then `uid`. Full stable sort. (Example: `2:00–2:30` precedes `2:00–3:00`.)

Per-instance shape:

```ts
interface MeetingInstance {
  start: Date;
  end: Date;                     // real DTEND, or start + 30 min if absent
  allDay: boolean;
  title: string;
  sourceFeedId: string;
  candidate: JoinCandidate;      // §6 — tier (a) or (b)
}
```

The key at `offset N` renders the Nth element of this list (0-indexed). Fewer than `N+1` events in scope today → that key shows "Free" (§8).

### Display horizon = today only

- The countdown only counts to the next in-scope event **starting today** (machine-local date).
- If the next in-scope event starts on a **future** day → green **"Free" + hint** of the next meeting (e.g. `Free · Mon 9:00`).
- If there are no future in-scope events at all → plain **"Free" / "No meetings"** (empty hint).
- The horizon rolls over at local midnight.

### Timezone

- The countdown is timezone-agnostic: it is `instance.start` (an absolute instant) minus `now`.
- Displayed wall-clock times and the "today" boundary use the **machine-local** timezone (an 11pm meeting is still "today").

---

## 6. Join-URL extraction, canonicalization & tiering

This is the security-critical core. The extractor lives in `src/calendar/extract.ts`, owns **both** extraction and canonicalization, and returns a **tiered, canonicalized** result — never a raw URL.

### 6.1 Extraction precedence (which property carries the link)

First property that yields a valid `http(s)` URL wins. **node-ical key names** shown (it strips a leading `X-`):

| Rung | node-ical access | Notes |
|------|------------------|-------|
| 1. Google conference | `ev['GOOGLE-CONFERENCE']` | `X-GOOGLE-CONFERENCE` with `X-` stripped; plain string |
| 2. Location (if a URL) | `ev.location` | only if the whole value is a URL; Zoom's carrier, and Meet mirrors here |
| 3. Description body | `ev.description` | scan for first embedded URL |
| 3b. Alt-desc body | `ev['ALT-DESC']` | `X-ALT-DESC` de-prefixed; **`{ params, val }`** shape when `FMTTYPE` present → read `.val` |
| 4. URL property | `ev.url` | plain string |

Helper rules:

- **De-prefix:** `key.replace(/^X-/i, '')`, upper-case. (Applies to `X-GOOGLE-CONFERENCE`, `X-ALT-DESC`.)
- **Params unwrap:** a parametrized property comes back as `{ params, val }`; read via `typeof v === 'string' ? v : v.val`. Non-parametrized properties are plain strings.
- **Read the parser's unfolded value**, never regex the raw `.ics` (RFC 5545 §3.1 folds lines at 75 octets with `CRLF`+space). `firstUrlIn(text)` scans a single unfolded property value for `https?://…` tokens (whitespace / `<>` / `"`-delimited).
- **`isJoinUrl(s)`:** `new URL(s)` must not throw **and** `protocol` ∈ {`http:`, `https:`} (rejects `mailto:`, `tel:`, physical addresses).
- **Disambiguation (optional):** when a body embeds multiple URLs, prefer known conferencing hosts — `meet.google.com`, `*.zoom.us`, `teams.microsoft.com`, `teams.live.com`, `*.webex.com` — before falling back to the first URL.

> **Library note (#47):** a single library — **`node-ical`** — is used for both the engine and extraction. `ical.js` v2 ships no bundled timezone dataset and returns a wrong `floating` instant for feeds with a bare `TZID` and no `VTIMEZONE`; `node-ical` resolves it correctly with zero registration. The two-library split once contemplated in #37/#38 is rejected.

### 6.2 Canonicalization — the security invariant

**Invariant: the attacker never controls the URL's scheme or host.** "Parses as `http(s)`" is *not* sufficient — calendar invites are attacker-controllable. For each recognized provider, extract only the characterizing token, validate it against a strict shape, and **reconstruct** the URL from a hard-coded template. Patterns are plain hard-coded constants in the plugin — **no config-over-the-wire** (this is deliberately *not* a `SelectorRegistry`).

**Google Meet — full reconstruct.**
- Validate code against `^[a-z]{3}-[a-z]{4}-[a-z]{3}$`.
- Reconstruct `https://meet.google.com/<code>`. **Discard** all query and fragment.

**Zoom — host-validate + reconstruct.**
- Pin host against `^([a-z0-9-]{1,63}\.)?zoom\.us$`.
- Validate numeric meeting id against `^\d{9,11}$`.
- Reconstruct `https://<validated-host>/j/<id>`, preserving **only** a `pwd` param that matches `^[A-Za-z0-9._-]{1,128}$`; discard every other param.

**Microsoft Teams — host-pinned allowlist passthrough.**
- Accept the raw URL **only if** scheme is `https`, host is exactly `teams.microsoft.com`, and path begins `/l/meetup-join/`. Pass the opaque token through untouched. Reject anything else.

### 6.3 Tiers

The extractor classifies each event into one of three tiers:

- **(a) Canonicalizable** — recognized provider, token valid → result `{ provider, code?, joinUrl }` where `joinUrl` is the reconstructed/allowlisted URL. Press opens `joinUrl`.
- **(b) Candidate present but not canonicalizable** — a join candidate exists but is an **unknown provider** *or* a **recognized-but-invalid token** (e.g. `X-GOOGLE-CONFERENCE` present but malformed). A marker; **still surfaced as a meeting**. Press opens a **feed-derived calendar URL** (see below), never the event's untrusted `URL` property.
- **(c) No candidate** — not a meeting; excluded from selection (unchanged from the §5 scope).

Return contract:

```ts
type JoinCandidate =
  | { tier: "a"; provider: "gmeet" | "zoom" | "teams"; code?: string; joinUrl: string }
  | { tier: "b" }        // surfaced; opener supplies the fallback URL
  ;                       // tier (c) → extractor returns null, instance is dropped
```

- **Fail-safe under drift:** a validation mismatch is **never** an error and **never** a dead key — it demotes (a) → (b). Worst case when Google renames a code format: the button "opens your calendar" instead of the meeting. It never performs a hostile open and never bricks.
- **The tier-(a) `code`** (namespaced `<provider>:<code>`, e.g. `gmeet:abc-def-ghi`, `zoom:<id>`) is the *same* token used for join-detection (§10). One token feeds open, display, and join-detection.

### 6.4 Feed-derived calendar fallback (tier b)

- The **opener** (not the extractor — the extractor doesn't know the feed origin) derives a trusted calendar-home URL **from the feed's own origin** (the host the user chose by subscribing).
- This requires **no new config** — it is derived automatically from the existing feed URL.

---

## 7. Press → open

Two-tier open, both tiers consuming the **canonicalized** URL from §6 (never the raw extracted value).

### Tier 1 — default: host-delegated open

- `streamDeck.system.openUrl(joinUrl)` (`@elgato/streamdeck` `^2.1.0`). Thin wire command (`connection.send({ event: "openUrl", payload: { url } })`); the host performs the OS-level open into the **default** browser, cross-platform, no extra deps, no manifest permission.
- **Fire-and-forget:** the Promise resolves when the request is *sent to the host*, not when the browser opens. `.catch` + log only; **never block the key handler**.

### Tier 2 — configured: browser-profile targeting

When the surfaced event's `sourceFeed` has an `open: { browser, profile }` (§3):

- Build argv and exec with **`child_process.execFile`** (argv array, **never** a shell string; the URL is its **own argv element** — shell injection is impossible by construction). Fire-and-forget like tier 1.
- Per-OS invocation (Chromium family shares `--profile-directory`):
  - **macOS:** `open -na "<AppName>" --args --profile-directory=<profile> <url>`
  - **Linux:** `<binary> --profile-directory=<profile> <url>`
  - **Windows:** `<exe> --profile-directory=<profile> <url>`
- The plugin owns a per-OS argv table mapping the `browser` enum to `<AppName>` / `<binary>` / `<exe>`.
- `profile` is the literal `--profile-directory` **folder name** (`Default`, `Profile 1`, …) — *not* a display name. Docs/PI point the user at `chrome://version` → "Profile Path" → last path segment.
- **Degradation:** absent `open` ⇒ tier 1. Configured-but-spawn-fails (bad binary, wrong macOS app name, non-zero exit, OS not in table) ⇒ fall back to `openUrl(joinUrl)` **and** `showAlert()` + log. (Fire-and-forget means only spawn-level failure is detectable, not "wrong profile.")

### No-link / non-event press

Selection (§5) guarantees a *surfaced* event always has an openable target (tier (a) join URL or tier (b) calendar fallback). Only non-event states have nothing to open:

- **Between-meetings (Free):** press = **no-op**; optionally `showOk()` and/or trigger an on-demand re-poll.
- **No-feed / setup:** press = **no-op**; optionally `showAlert()` / nudge toward the Property Inspector.

Never error, never open a stale or previous URL.

---

## 8. Display & escalation model

**Variant A — countdown-primary:** the big `MM:SS` fills the 72×72 key; the meeting title is a thin top strip.

Countdown format: `MM:SS`; `Hh MM` when over an hour; `+MM:SS` when overdue.

Escalation states:

| State | Threshold | Colour | Behaviour |
|-------|-----------|--------|-----------|
| normal | `> 5 min` | slate | steady |
| approaching | `≤ 5 min` | orange | steady |
| imminent | `≤ 30 s` | red | **gentle blink** (~1.2 s period) |
| late | past start (`< 0`) | flashing red | **hard flash** (~0.9 s period), counts **up** `+MM:SS` |
| joined | extension reports in-call for this event | — | **dismiss late, advance** to next event (§10) |

Non-countdown states:

- **Between meetings:** green **"Free"** (+ next-meeting hint when the next in-scope event is a future day, e.g. `Free · Mon 9:00`).
- **No feed / unconfigured** (empty or dangling `feedId`): **setup prompt** (nudge to the Property Inspector).
- **Cold-start error** (§9): a **dedicated error/attention state** — warning glyph / muted red (e.g. `No data` / `!`) — that is **visually distinct** from both green "Free" and the setup prompt.

The **late state is not open-ended** — it ends on join-proof or the grace timer (§10), then hands rendering back to the boundary logic (§9), which advances the selection.

---

## 9. Polling cadence, freshness & boundaries

**Two decoupled clocks.**

### Render clock — 500 ms, local, never networks

A fixed 500 ms local timer does pure arithmetic (`now` vs the cached event set): drives the `MM:SS` countdown (visibly ticks once/sec) and the blink/flash timing. A failed fetch **never** freezes or blanks the key — the render clock keeps counting off cached data.

### Feed-poll clock — 15 min (configurable), network

- Baseline: fixed **`pollIntervalMinutes`** (default **15**, from `GlobalSettings`). No adaptive tiering.
- **Forced polls** layered on the baseline, each using the same conditional-GET path (§4):
  - **Startup** — key added, config URL changed, or plugin re-init → immediate fetch.
  - **Boundary crossing** — when the current event ends and the key advances, poll once to confirm the new head is real.
- **Deferred past v1:** wake-from-sleep / network-reconnect forced poll.

### Meeting-boundary behavior

- The current event stays current until its scheduled `end` (§5 sort governs ordering; `end > now` governs currency).
- Past `start` → late flash `+MM:SS` (§8); at `end` → advance to the next list element. Count-up is bounded by the meeting duration (and by grace / DTEND, §10).
- **Join advances early:** a §10 in-call signal before `end` advances immediately.

### Freshness / fetch-failure

- **Failure with a usable cache** → keep rendering the countdown off cache; log the error (never the secret URL, including in error paths); retry next cadence. **No visible change in v1.**
- **Failure with no cache (cold start)** — network down at launch, or URL wrong/revoked (401/403/404) → the **dedicated error state** (§8). No auth-vs-network special-casing in v1.
- **Deferred past v1:** stale-data indicator (dimming after N consecutive failures despite a valid cache).

---

## 10. Extension join-detection (optional input)

The extension is **optional** — everything above works with Chrome closed. When present, it lets the plugin dismiss the late state the instant you actually join, rather than waiting for the grace timer. Still **no auto-join, no DOM driving** — this is read-only detection.

### The wire signal — new `callState` StateEvent

- Add `StateEvent.CallState = "callState"` to `@callctl/protocol` (`protocol/src/events.ts`). This is the **only** protocol change in the whole feature.
- The extension pushes it plugin-ward over the local ws (:2395):
  - **Joined:** `data` = the provider-namespaced canonical code, e.g. `{"event":"callState","data":"gmeet:abc-def-ghi"}`.
  - **Not in a call:** the event with **no `data`** → `{"event":"callState"}`.
- Pushed on **transition** (the "Leave call" button appears/disappears, or the URL/code changes) **and on connect** (via the existing `transmit()`).
- The `gmeet:` prefix future-proofs against code collisions across providers. The extension emits only `gmeet:` today.

### "Joined" = code match **and** in-call proof

The extension emits `gmeet:<code>` only when **both**:
1. the Meet URL code matches, **and**
2. the **"Leave call" button** is present (`SelectorKey.Leave`, already maintained).

The Leave button renders only once admitted and in the call — this avoids false positives in the green room / admission lobby (same `meet.google.com/xxx-xxxx-xxx` URL). Tradeoff: if Google renames the Leave aria-label (selector drift), detection silently stops and the key falls back to the grace timer — acceptable, because the timer is the primary path.

### Plugin side

- `MeetRemote` caches `joinedKey: string | null` from the `callState` input (add an input handler + reader).
- `NextMeetingAction` compares `joinedKey` (case-insensitive) against the surfaced event's normalized `<provider>:<code>` (the tier-(a) `code` from §6). A match ⇒ dismiss the late state + advance.
- **Windowed match:** compare the incoming code against **all tracked near-term events**, not just the currently-surfaced one. If you skip event N and join N+1 directly, a hit advances past everything up to and including the matched event.

### The fallback — always active, primary path

Because the extension is optional, a **time-based fallback is primary and always on**:

- **Dismiss the late state at `min(join-proof, start + graceMinutes, DTEND)`.**
- **`graceMinutes` default = 10**, exposed as a per-key Property Inspector setting (§3, §11).
- **Capped at `DTEND`** — never flash-late past a meeting that already ended (e.g. a 5-minute standup).

### Interactions

- A **press does not count as join-proof** (opening ≠ joining) — only real join-proof or the grace timer dismisses.
- §10 owns *when* the late state ends; §9 owns *what the key shows afterward* (dismissal advances the selection, then hands rendering back to the boundary logic).

---

## 11. Setup & config UX (Property Inspector)

The plugin's first Property Inspector — one HTML file, present on every Next-Meeting key.

**Layout:**

1. **Per-key** `Feed: [ ▾ ]` dropdown, populated from the global feed list; stores `feedId`.
2. **Per-key** `Offset: [ 0 ]` (default 0) and `Grace (min): [ 10 ]` (default 10).
3. Expandable **"Manage feeds (global)"** editor — rows of `[name] [url] [x]` + `[+ Add feed]`, writing the global `feeds[]` list. For each feed:
   - The **URL** field is **masked with a 👁 reveal toggle**.
   - On entry, **validate the scheme**, **rewrite `webcal://` → `https://`**, and reject non-`http(s)`.
   - Optional **`Open in:` `[browser ▾] [profile]`** controls (the per-feed `open`); empty ⇒ default `openUrl`. Help text points at `chrome://version` for the profile folder name.
   - A **`[Test]`** button → the PI asks the plugin to fetch + parse the feed (reusing the §4–§5 engine) and reports: reachable? parsed *N* events? next joinable event — or a specific error (401, not-a-calendar, timeout).
4. **Global** `Poll interval (min): [ 15 ]` (default 15).

**Empty/broken:** a key with no `feedId`, or a `feedId` pointing at a deleted feed, → the §8 no-feed setup prompt.

**Credential guidance (docs + PI copy):** "treat the feed URL like a password"; explain how to rotate (regenerate the secret feed URL at the provider).

---

## 12. Security posture

- **URL injection (§6.2):** the attacker never controls scheme or host. Per-provider tokenize → strict-validate → reconstruct; mismatch fail-safes to the feed-derived calendar URL. Patterns are hard-coded constants — not config-over-the-wire.
- **Shell injection (§7):** the configured open path uses `execFile` with an argv array and the URL as its own argv element — no shell, injection impossible by construction. The only user inputs are the `browser` enum (safe) and the `profile` folder name (a single argv element).
- **Secret handling (§3, §4):** the feed URL is a capability secret. Stored plaintext in **global** settings only (keychain ruled out as too much native surface for v1), never in per-key settings, so it stays out of `.streamDeckProfile` exports. Shown masked + reveal in the PI. **Never logged**, including in error paths.

---

## 13. Traceability

| Section | Decided in |
|---------|-----------|
| Premises, scope | [#35 map](https://github.com/sigma/callctl/issues/35) |
| Prior-art mining | [#36](https://github.com/sigma/callctl/issues/36) |
| Extraction precedence (§6.1) | [#37](https://github.com/sigma/callctl/issues/37), keys adapted per [#47](https://github.com/sigma/callctl/issues/47) |
| Engine, fetch, recurrence, placement (§2, §4, §5) | [#38](https://github.com/sigma/callctl/issues/38) |
| Display & escalation (§8) | [#39](https://github.com/sigma/callctl/issues/39) |
| Open mechanism + no-link fallback (§7) | [#40](https://github.com/sigma/callctl/issues/40) |
| Polling, freshness, boundaries, ordered list, offset (§5, §9) | [#41](https://github.com/sigma/callctl/issues/41) |
| Config UX / PI, settings schema (§3, §11) | [#42](https://github.com/sigma/callctl/issues/42) |
| Single ics library = node-ical (§4, §6 note) | [#47](https://github.com/sigma/callctl/issues/47) |
| Join-detection, `callState`, grace fallback (§10) | [#48](https://github.com/sigma/callctl/issues/48) |
| Configurable open command / profile targeting (§7 tier 2) | [#51](https://github.com/sigma/callctl/issues/51) |
| URL hardening / canonicalization / tiers (§6.2–§6.4, §12) | [#52](https://github.com/sigma/callctl/issues/52) |

Research assets (on their PR branches): [stream-deck-ical prior art](https://github.com/sigma/callctl/blob/wf-research-stream-deck-ical/docs/research/stream-deck-ical.md), [join-URL extraction](https://github.com/sigma/callctl/blob/wf-37-ical-join-url/docs/research/ical-join-url-extraction.md), [ics library decision](https://github.com/sigma/callctl/blob/wf-47-ics-library-decision/docs/research/ics-library-decision.md), [click → open](https://github.com/sigma/callctl/blob/sigma/push-urpynvtqvlwm/docs/research/click-open-join-url.md).

## 14. Out of scope / deferred (v1)

**Out of scope** (would require redrawing the destination):

- Google Calendar API / OAuth / GCP project — the secret iCal feed is confirmed sufficient.
- Auto-join / Meet-DOM *driving* — press only opens a URL; join-**detection** (§10) is read-only.
- Displaying non-link events — scope is join-link events only.
- The build itself — this is a planning artifact.

**In scope but deferred past v1** (nice-to-haves, not blockers):

- Carrying the reference's other modes (Smart Calendar / Time-Left-in-meeting) — v1 ships Next-Meeting only.
- OS-level notifications beyond the key LCD.
- Wake-from-sleep / network-reconnect forced poll (§9).
- Stale-data indicator — dim the key after N failed polls despite a valid cache (§9).
