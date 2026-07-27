# Research: click → open join URL in the default browser (+ no-link fallback)

Resolves wayfinder ticket [#40](https://github.com/sigma/callctl/issues/40)
(map [#35](https://github.com/sigma/callctl/issues/35), "Next Meeting" deck action).

Two questions:

1. **Mechanism** — how the plugin opens the join URL in the user's default
   browser (Elgato SDK `openUrl` vs shelling out to the OS), cross-platform.
2. **No-link fallback** — what a press does when there is no join URL to open.

## 1. Mechanism: use `streamDeck.system.openUrl(url)`

The `@elgato/streamdeck` SDK (we ship **v2**, `^2.1.0`) exposes a first-party
opener on the `system` namespace:

```ts
import streamDeck from "@elgato/streamdeck";
await streamDeck.system.openUrl(joinUrl);
```

Declared in `dist/plugin/system.d.ts`:

> **`openUrl(url: string): Promise<void>`** — Opens the specified `url` in the
> user's default browser. Returns a `Promise` resolved when the request to open
> the `url` has been *sent to Stream Deck*.

### How it actually works

`openUrl` is a thin wire command, not a local shell-out. Its implementation
(`dist/plugin/system.js`) only sends an envelope over the plugin↔host websocket:

```js
export function openUrl(url) {
  return connection.send({ event: "openUrl", payload: { url } });
}
```

The **Stream Deck host application** receives that `openUrl` command and performs
the OS-level open in the user's default browser. Cross-platform behaviour
(macOS / Windows) is therefore the host's responsibility, not ours.

### Why this beats the OS-level alternative

The alternative — shelling out from our Node process via `child_process` to
`open` (macOS) / `start` (Windows) / `xdg-open` (Linux), or pulling in the `open`
npm package — is strictly worse here:

| | `streamDeck.system.openUrl` | OS-level shell-out / `open` pkg |
|---|---|---|
| Cross-platform | Host handles it | We branch per-OS or trust a dep |
| Dependencies | None (already imported) | Extra dep or hand-rolled spawn |
| Availability | Host is always connected (the plugin runs *because* the host launched it) | Depends on our process's env/PATH |
| Failure surface | One Promise to `.catch`/log | Per-OS spawn errors, quoting, PATH |

For the **plain "open in the default browser" case there is no capability the
shell-out buys us that `openUrl` lacks**, so `openUrl` is the default and adds no
browser-opening dependency.

> **But there is one capability the shell-out buys us:** `openUrl` gives the host
> a bare URL and cannot say *which* browser or **browser profile** to use — it
> lands in the default browser's default/last-used profile. Targeting a specific
> Chrome **profile** (so a "work" calendar opens in the "work" profile) *requires*
> a CLI invocation like `open -na "Google Chrome" --args --profile-directory="Work" <url>`.
> So the row above holds only for the default case; profile routing reopens the
> shell-out as a **configurable, opt-in** path — see the update section below and
> ticket [#51](https://github.com/sigma/callctl/issues/51).

### Usage notes for the spec

- **Fire-and-forget on press.** The returned Promise resolves when the request
  is *sent to the host*, not when the browser has actually opened — do not treat
  resolution as "the meeting opened". `await` only to attach a `.catch` that logs
  a failed send; do not block the key handler on it.
- **URL must be `http(s)`.** The host opens what it's given; feed it only a
  validated `http(s)` URL. This lines up exactly with #37's `hasJoinLink`
  contract (the extraction chain yields a valid `http(s)` URL or nothing), so the
  opener consumes the same validated value with no extra checks.
- No `manifest` permission or `ApplicationsToMonitor` entry is required for
  `openUrl`.

## 2. No-link fallback: selection guarantees a link; press-with-nothing is a no-op

The map's locked scope is **"only events that have a join link"**, and the
selection engine (#38) already selects the *most-imminent **link-bearing**
instance*. So:

- **The button never surfaces a no-link event.** Non-link events are filtered out
  during selection, not skipped at press time. When the key is displaying an
  event, that event has a link **by construction** — a press always has a URL to
  open. There is no "press surfaced a linkless meeting" case to design for.

- The only press-with-nothing-to-open cases are the **non-event key states** from
  the display prototype (#39), where the key isn't showing a meeting at all:
  - **Between-meetings** ("Free" / green) — no upcoming link-bearing event.
  - **No-feed / setup** state — nothing configured yet.

  In these states a press has nothing to open. Decision: **press is a no-op** —
  do not error, do not open a stale/previous URL. Optionally give gentle
  feedback:
  - Between-meetings: a brief `showOk()` and/or an on-demand feed **re-poll**
    (cheap "refresh now" affordance), then repaint.
  - No-feed: `showAlert()` and/or nudge the user toward the Property Inspector;
    never throw.

**Net:** the "no-link fallback" is not a fallback on the *event* (selection
removes that case) but on the *non-event states*, where the answer is a safe
no-op with optional feedback.

## Update: `openUrl` can't target a browser profile → configurable open command

`streamDeck.system.openUrl` hands the host a **bare URL**. The host opens it in
the OS **default browser**, in that browser's default/last-used **profile**.
There is no argument — in the SDK command or the host protocol — to pick a
browser or a profile.

Real requirement (user, this effort): an event from the **"work" calendar**
should open in the **"work" Chrome profile**; a personal event in the personal
profile. That is exactly the capability `openUrl` lacks, and it can only be had by
invoking the browser's own CLI with a profile flag, e.g.:

- macOS: `open -na "Google Chrome" --args --profile-directory="Work" <url>`
- Linux: `google-chrome --profile-directory="Profile 1" <url>`
- Windows: `chrome.exe --profile-directory="Profile 1" <url>`

So the mechanism is **two-tier**:

- **Default** (no config): `streamDeck.system.openUrl(joinUrl)` — the simple,
  dependency-free, cross-platform path decided above.
- **Configured**: when the surfaced event's feed/config supplies an **open
  command**, run that instead (plugin is a local Node process, so it can
  `child_process.execFile`/`spawn`), so the URL lands in the chosen
  browser/profile.

The *design* of that configuration — granularity (per-feed vs per-event vs
global), template format & `{url}` placeholder vs structured `{browser, profile}`,
cross-platform handling, argv-not-shell execution to avoid injection, and
fallback when the command is empty/invalid — is **not** settled here. It is a
HITL design decision, spun out to ticket
[#51](https://github.com/sigma/callctl/issues/51), and it dovetails with the
still-in-fog setup/config UX.

## Decisions this locks for the spec

1. **Default open** = `await streamDeck.system.openUrl(joinUrl)` (host-delegated,
   no deps, cross-platform).
2. **`openUrl` cannot target a browser profile.** Per-calendar profile routing
   requires a **configurable open command** (CLI shell-out) as an opt-in override
   of the default. Mechanism is two-tier: `openUrl` unless the config supplies an
   open command. *(Design of the config → ticket #51.)*
3. Treat the `openUrl` Promise as "request sent", not "browser opened";
   `.catch`+log only.
4. Consume the #37-validated `http(s)` URL directly — no extra URL validation at
   the opener.
5. A surfaced event always has a link (guaranteed by #38 selection); the button
   never surfaces a linkless event.
6. Press in a non-event state (Free / no-feed) is a **no-op**, optionally with
   `showOk`/re-poll or `showAlert`, never an error and never a stale URL.
