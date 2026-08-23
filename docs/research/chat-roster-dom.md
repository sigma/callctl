# What does the `chat.google.com` roster DOM actually expose?

> Research asset for [Map: Google Chat unread](https://github.com/sigma/callctl/issues/104),
> ticket [#105](https://github.com/sigma/callctl/issues/105). Blocks
> [#110](https://github.com/sigma/callctl/issues/110) and
> [#111](https://github.com/sigma/callctl/issues/111).
> Primary sources: [Chrome extensions `content_scripts` manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts),
> [Chrome content-scripts concepts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
> [Google Chat API v1 REST reference](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces),
> [Google Chat Help — use Google Chat with a screen reader](https://support.google.com/chat/answer/7652236?hl=en&co=GENIE.Platform%3DDesktop),
> [Google Workspace Updates](https://workspaceupdates.googleblog.com/) (Google's own release-notes blog),
> plus **direct unauthenticated HTTP probes of `chat.google.com` and `mail.google.com`**
> (the server's own response headers and routing behaviour — reproduced in §1.2 and §2.1
> so anyone can re-run them).

---

## 0. Verified vs. hypothesis — read this first

**The author of this note could not log into a Google account.** No live, authenticated
Chat DOM was inspected. Every selector-level statement below is therefore explicitly
labelled. Nothing in this document is a class name, `aria-label`, or CSS selector invented
to look plausible — where a selector would be needed, you will find an *investigation
step* instead (§5).

| # | Claim | Status |
|---|---|---|
| 1 | MV3 `all_frames` defaults to `false`; each frame is matched independently against `matches` | ✅ **Verified** — Chrome docs, quoted §1.1 |
| 2 | `chat.google.com` sends `X-Frame-Options: SAMEORIGIN` — so it can only ever be framed by itself | ✅ **Verified** — live header probe, §1.2 |
| 3 | `chat.google.com`'s CSP `frame-src` allowlist bounds which origins can appear as child frames, and is dominated by content/picker/add-on origins plus `'self'` | ✅ **Verified** — live header probe, §1.3 |
| 4 | The Chat-in-Gmail surface is served from `mail.google.com/chat/u/0/`, **not** from a `chat.google.com` iframe | ✅ **Verified** — header + redirect probe, §1.4 |
| 5 | `chat.google.com/room/<id>` and `chat.google.com/dm/<id>` are real routes; `/space/<id>` is **not** | ✅ **Verified** — routing probe, §2.1. ⚠️ This **contradicts the ticket's premise** of `/space/<id>` |
| 6 | The Chat REST API's stable ids are `spaces/{space}`, and read-state resources are `users/{user}/spaces/{space}/spaceReadState` | ✅ **Verified** — API reference, §2.2 |
| 7 | The REST read-state model carries **no unread count** — only `lastReadTime` | ✅ **Verified** — `SpaceReadState` schema, §2.2 |
| 8 | Google documents the space's web URL as `https://mail.google.com/chat/u/0/#chat/space/{id}` | ✅ **Verified** — Chat API guide, §2.3 |
| 9 | Chat's left navigation **does** expose unread state to assistive technology, and Chat has a first-class "next unread conversation" navigation primitive | ✅ **Verified** — Chat screen-reader help, §2.4 |
| 10 | "Unread/bolded" and "badged/notifying" are **distinct product concepts in Google's own model**, and they demonstrably diverge | ✅ **Verified** — Workspace Updates + Chat Help, §3 |
| 11 | The devbridge's `DebugPlugin` is platform-agnostic (`document`-only) and would work on any page the content script reaches | ✅ **Verified** — source read, §5.2 |
| 12 | The devbridge holds exactly **one** extension socket; a second connection closes the first | ✅ **Verified** — `debug-bridge.ts` `#onExtension`, §5.3 |
| 13 | The roster lives in the **top frame** of `chat.google.com` | 🔬 **HYPOTHESIS** — strongly narrowed by (2)(3) but **not confirmed**. Run §5.4 |
| 14 | A roster row carries a DOM-visible stable conversation id | 🔬 **HYPOTHESIS** — plausible via `href`, unconfirmed. Run §5.5 |
| 15 | A roster row carries a machine-readable per-conversation unread count | 🔬 **HYPOTHESIS** — (9) makes it near-certain that *some* unread signal is in the a11y tree; whether it is a **number** per row is unknown. Run §5.6 |
| 16 | "Bold-unread" and "badge-notifying" are separable *in the DOM* | 🔬 **HYPOTHESIS** — (10) proves they are separable *in the product*. Run §5.7 |
| 17 | Adding `https://chat.google.com/*` to the existing content script does not break the Meet plugins | 🔬 **HYPOTHESIS** — code read suggests the Meet model just observes nothing, §5.3. Unverified |

**Everything in rows 13–17 requires a live authenticated session.** §5 is the runnable
procedure for settling them; it is the operative deliverable of this note.

---

## TL;DR

1. **Reachability is *bounded*, not *settled*.** `chat.google.com` cannot be framed from
   outside itself (`X-Frame-Options: SAMEORIGIN`), and its CSP `frame-src` allowlist
   contains no origin that plausibly hosts a conversation roster other than `'self'`. So
   the roster is either the top frame or a **same-origin** child frame — and
   `matches: ["https://chat.google.com/*"]` + `all_frames: true` covers **both** cases with
   one host permission. *Ship `all_frames: true` regardless*; it is cheap insurance and
   costs nothing if the roster turns out to be top-frame. See [§1](#1-reachability).
2. **The ticket's URL premise is wrong and the correction matters.** Chat's routes are
   `/room/<id>` and `/dm/<id>` (plus `/u/<n>/` prefixes and an optional `/<threadId>`
   suffix). There is **no `/space/<id>` route** — it bounces to the app root. See
   [§2.1](#21-which-chatgooglecom-routes-actually-exist).
3. **A stable id exists in the product model and is almost certainly in an `href`.** The
   REST API names spaces `spaces/{space}` and Google's own docs tell you to build the web
   URL from that id — so the id in a roster link is the same opaque token the API uses.
   That gives us confidence the id is stable across reloads and navigable. **It does not
   prove the roster renders it as an `href`.** See [§2](#2-per-conversation-identity).
4. **Unread state is in the accessibility tree — Google says so.** The Chat screen-reader
   guide states you are "told if there are unread messages" as you move through the left
   navigation, and documents `Shift + Up/Down` as *move to previous/next unread
   conversation*. Chat therefore has a per-row unread predicate the DOM must expose to AT.
   See [§2.4](#24-what-google-tells-us-about-the-accessibility-tree).
5. **Unread ≠ notifying, confirmed by Google's own documentation, and the divergence is
   bidirectional.** Mute suppresses bolding *and* top-sorting but **still badges @mentions**;
   "Notifications off" suppresses badges but **still bolds**. Both directions of the
   asymmetry are documented. See [§3](#3-unread-vs-notifying).
6. **This partially threatens the map's "mirror what Chat badges" decision — but as a
   *semantics* problem, not a *feasibility* problem.** A badge count on a `Notify less`
   space counts **mentions**, not messages, so summing badges yields a number that is not
   "unread messages" in any uniform sense. See [§4](#4-does-this-threaten-the-maps-decision).
7. **The devbridge can be pointed at Chat with a three-line manifest change**, because
   `DebugPlugin` only ever touches `document`. The blocker is not the debug surface, it is
   that the bridge is **single-client** — so Meet and Chat content scripts will fight over
   it. Close the Meet tab for the investigation. See [§5](#5-investigation-procedure).

---

## 1. Reachability

### 1.1 What MV3 actually guarantees

From the [`content_scripts` manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts),
verbatim:

> The `"all_frames"` key specifies if the content script should be injected into all frames
> matching the specified URL requirements. If set to `false` it will only inject into the
> topmost frame.

and, on the property itself:

> _Optional_. Defaults to `false`, meaning that only the top frame is matched. If set to
> true, it will inject into all frames, even if the frame is not the topmost frame in the
> tab. **Each frame is checked independently for URL requirements, it won't inject into
> child frames if the URL requirements are not met.**

That last sentence is the load-bearing one. `all_frames: true` is **not** "inject
everywhere in this tab" — it is "evaluate `matches` against *every* frame's own URL". So:

- A same-origin `https://chat.google.com/...` child frame **is** covered by
  `matches: ["https://chat.google.com/*"]` + `all_frames: true`.
- A cross-origin child frame (say `https://chat.usercontent.google.com/...`) is **not**,
  and would need its own match pattern *and* its own `host_permissions` entry.

Two adjacent knobs, for completeness:

> `match_about_blank` — _Optional._ Whether the script should inject into an `about:blank`
> frame where the parent or opener frame matches one of the patterns declared in `matches`.
> Defaults to false.

> To inject into other frames like `data:`, `blob:`, and `filesystem:`, set the
> `"match_origin_as_fallback"` to `true`.

and from the [concepts page](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts):

> When specified and set to `true`, Chrome will look at the origin of the initiator of the
> frame to determine whether the frame matches, rather than at the URL of the frame itself.

`match_origin_as_fallback` is for `about:`/`data:`/`blob:`/`filesystem:` frames and for
frames with **opaque origins** — which is exactly what a CSP-sandboxed frame has. Keep it
in mind for §1.3; it is almost certainly *not* needed for the roster.

Note also that the content script runs in an **isolated world**:

> An **isolated world** is a private execution environment that isn't accessible to the
> page or other extensions.

So we read the DOM, not the page's JS state. No access to Chat's internal model objects
without a `MAIN`-world injection — out of scope here, and a much worse bet than the DOM.

### 1.2 `chat.google.com` framing headers (live probe)

Reproduce with:

```sh
curl -sS -o /dev/null -D - https://chat.google.com/ | grep -i 'x-frame-options\|cross-origin'
```

Observed (2026-08-23, unauthenticated; the response is the 302 to the login page):

```
x-frame-options: SAMEORIGIN
cross-origin-opener-policy: same-origin-allow-popups
cross-origin-resource-policy: same-site
cross-origin-embedder-policy-report-only: require-corp; report-to="DynamiteWebUi"
```

**`X-Frame-Options: SAMEORIGIN` is decisive for one direction:** nothing outside
`chat.google.com` can embed `chat.google.com`. Whatever the Chat UI's internal frame
topology is, every frame in it that *is* Chat is same-origin with the top frame.

⚠️ **Caveat, stated plainly:** these headers come from the **redirect-to-login** response,
not from the authenticated app response. Google is unlikely to relax framing for signed-in
users, but this has not been observed. §5.4 confirms it against the real page.

A per-route sweep of the same header shows one interesting split, reproducible:

| Route | `X-Frame-Options` |
|---|---|
| `/` | `SAMEORIGIN` |
| `/u/0/` | `SAMEORIGIN` |
| `/room/<id>` | `SAMEORIGIN` |
| `/mole/world`, `/u/0/mole/world` | **`DENY`** |

"Mole" is Google's internal term for the small docked chat window. That those routes are
`DENY` is further evidence that *nothing* frames `chat.google.com` cross-origin, including
Gmail — corroborating §1.4.

### 1.3 What `chat.google.com` is allowed to frame (live probe)

The same response carries a long CSP. Its `frame-src` directive is the exhaustive list of
origins that can appear as a child frame of the Chat app. Abridged to the distinct hosts
(full value in the raw header):

```
frame-src 'self'
  https://chat.usercontent.google.com/          https://docs.google.com/
  https://docs.google.com/picker/               https://drive.google.com/
  https://contacts.google.com/                  https://tasks.google.com/
  https://calendar.google.com/calendar/         https://keep.google.com
  https://meet.google.com/                      https://notifications.google.com/
  https://accounts.google.com/                  https://ogs.google.com/
  https://myaccount.google.com/…                https://workspace.google.com/…
  https://www.youtube.com/embed/                https://feedback.googleusercontent.com/
  https://scone-pa.clients6.google.com/         https://feedback-pa.clients6.google.com/
  https://people-pa.clients6.google.com/static/ https://client-side-encryption.google.com/
  … (plus *.sandbox.google.com / *.corp.google.com dev origins)
```

Read this as a **negative result that narrows the search**: every non-`'self'` entry is
recognisably an *attachment preview, file picker, add-on, notification centre, OneGoogle
bar, feedback widget, or account surface*. None of them is a plausible host for the
conversation roster. Therefore **the roster is served from `chat.google.com` itself** —
top frame or same-origin child.

`chat.usercontent.google.com` deserves a specific note. Probing it:

```sh
curl -sS -o /dev/null -D - https://chat.usercontent.google.com/ | grep -i content-security
# content-security-policy: sandbox allow-scripts
```

A bare `sandbox` directive gives that frame an **opaque origin**. That is the classic
untrusted-user-content sandbox — message body rendering, attachment previews. It is not the
roster, and it would be the one frame where `match_origin_as_fallback` mattered. **Do not
target it.**

### 1.4 Chat-in-Gmail is a different host entirely

```sh
curl -sS -o /dev/null -D - https://mail.google.com/chat/
# location: https://mail.google.com/chat/u/0/
# x-frame-options: SAMEORIGIN
```

`mail.google.com/chat/u/0/` is served by Gmail's origin and is `SAMEORIGIN` with the Gmail
top frame — so Gmail *can* frame it, and (given §1.2) it must, since it cannot frame
`chat.google.com`. Google's own Chat API guide reinforces that this is the canonical
in-Gmail address by giving the deep-link form
`https://mail.google.com/chat/u/0/#chat/space/1234567`
([create a space](https://developers.google.com/workspace/chat/create-spaces)).

**Consequence for the map:** the Chat-in-Gmail surface is a *separate integration target*
requiring `https://mail.google.com/*` in both `matches` and `host_permissions`, plus
`all_frames: true` (it is by construction a child frame of Gmail). #104 has scoped the
feature to a standalone Chat client, so this is out of scope — but it should be recorded as
a known non-covered case, because a user who reads Chat inside Gmail will see a dead key.

### 1.5 Verdict on (a)

**Settled:** the manifest shape. Use

```json
{
  "matches": ["https://chat.google.com/*"],
  "all_frames": true,
  "js": ["src/chat-content-script.ts"],
  "run_at": "document_idle"
}
```

with `"https://chat.google.com/*"` added to `host_permissions`. This is correct whether the
roster is top-frame or same-origin-nested, and no second origin is needed.

**Not settled:** which frame it actually lands in — and that matters operationally, because
with `all_frames: true` on a multi-frame app you get **N content-script instances**, each of
which will try to open a websocket. Whatever the Chat client does, it must decide *which*
instance owns the bridge connection (obvious candidate: `window.top === window` plus a
roster-presence check). Run §5.4 before writing that logic.

---

## 2. Per-conversation identity

### 2.1 Which `chat.google.com` routes actually exist

The login redirect preserves a recognised path in its `continue=` parameter and **discards**
an unrecognised one (bouncing to `https://chat.google.com/?hasBeenRedirected=true`). That
makes the redirector a free, unauthenticated route oracle. Reproduce:

```sh
for p in room/AAAA dm/AAAA space/AAAA group/AAAA home mentions threads \
         u/0/room/AAAA u/0/dm/AAAA room/AAAA/AAAB dm/AAAA/AAAB nonexistentpath/x; do
  printf '%-20s ' "$p"
  curl -sS -o /dev/null -D - "https://chat.google.com/$p" 2>/dev/null | grep -i '^location:'
done
```

Observed:

| Probe | Result |
|---|---|
| `/room/AAAA` | ✅ preserved → `continue=https://chat.google.com/room/AAAA` |
| `/dm/AAAA` | ✅ preserved |
| `/u/0/room/AAAA`, `/u/0/dm/AAAA` | ✅ preserved |
| `/room/AAAA/AAAB`, `/dm/AAAA/AAAB` | ✅ preserved (second segment = thread) |
| `/space/AAAA` | ❌ bounced to app root |
| `/group/AAAA`, `/home`, `/mentions`, `/starred`, `/threads` | ❌ bounced |
| `/nonexistentpath/x` | ❌ bounced |

**The navigable conversation URL grammar is therefore:**

```
https://chat.google.com/[u/<n>/]{room|dm}/<conversationId>[/<threadId>]
```

⚠️ #105 asks about "`/dm/<id>`, `/space/<id>`". **`/space/` does not exist** — Chat still
routes named spaces under the pre-rename `/room/` path, even though the product renamed
Rooms to Spaces in 2021 ([Workspace Updates](https://workspaceupdates.googleblog.com/2021/09/google-chat-rooms-are-now-spaces.html)).
Any spec text or `SelectorConfig` seeded from the ticket's wording would be wrong.

Also note the `u/<n>` account-index segment. That is the multi-profile axis #104 lists under
"Not yet specified" showing up in the URL grammar — a roster row's `href` will likely be
account-scoped, so the id alone is not a complete key when several accounts are signed in.

### 2.2 What the REST API says the stable id is

Even though #104 has ruled the REST API out as a *data source* (no plugin authentication),
its resource model is a primary source for **what identifiers Google considers stable**, and
those are the identifiers the web app is built on.

From the [`spaces` REST resource](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces):

- Resource name — `"Format: spaces/{space}"`, with the space ID described as a
  system-assigned identifier obtainable via `spaces.list()` **or extracted from the space
  URL**. That cross-reference is the important bit: Google states the URL id and the API id
  are the same token.
- `spaceUri` — `"Output only. The URI for a user to access the space."`
- `spaceType` — `SPACE`, `GROUP_CHAT`, or `DIRECT_MESSAGE`. Note this is a **three-way**
  distinction, while the URL grammar (§2.1) is only two-way (`room` / `dm`) — so a group DM
  and a 1:1 DM presumably share the `/dm/` path. Worth confirming in §5.5, because a roster
  render that keys on the path prefix will conflate them.
- `displayName` — `"Optional. The space's display name. Required when creating a space with
  a spaceType of SPACE."` **Optional**, and only *required* for named spaces — so a DM or
  group chat may legitimately have no display name and the web UI synthesises one from the
  members. A wire roster must not assume a name is present.

Read-state resources:

- [`users.spaces.getSpaceReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces/getSpaceReadState)
  — `"users/{user}/spaces/{space}/spaceReadState"`, described as
  `"used to identify read and unread messages"`.
- [`users.spaces.threads.getThreadReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces.threads/getThreadReadState)
  — `"users/{user}/spaces/{space}/threads/{thread}/threadReadState"`.

**Both confirm the ticket's hunch that the API embeds the same `{space}` id the DOM would
carry.** But the `SpaceReadState` schema is only two fields:

| Field | Description |
|---|---|
| `name` | `"Resource name of the space read state. Format: users/{user}/spaces/{space}/spaceReadState"` |
| `lastReadTime` | `"Optional. The time when the user's space read state was updated. Usually this corresponds with either the timestamp of the last read message, or a timestamp specified by the user to mark the last read position in a space."` |

**There is no unread-count field anywhere in the public read-state model.** Google's own API
models unread as a *watermark timestamp*, not a count. That is a genuinely useful negative:
it means a per-conversation *count* is a **presentation-layer** artefact computed by the
client, and if the DOM does not render it, there is no public server-side number to fall
back on. It also means the map's roster field "per-conversation count" is the one field most
at risk of not existing.

### 2.3 Display name and avatar

Nothing in primary sources describes the roster's rendering. What is documented:

- `displayName` is optional (§2.2), so a DM row's name is client-synthesised.
- Chat's help documents a left-navigation split into "Shortcut section, Direct message
  conversation, or Space" (§2.4), which is a *structural* fact about the roster: it is
  sectioned, and the sections are DM vs Space vs Shortcuts.

Avatar/initial is **entirely unverified**. Do not assume an `<img>`; Chat may render an
initial-letter `<div>` for spaces without a custom avatar, and any `<img>` will point at
`*.googleusercontent.com` (allowed by the observed `img-src` directive:
`img-src blob: data: 'self' https://*.ggpht.com https://*.gstatic.com https://*.googleusercontent.com …`).
An avatar URL is a cross-origin resource — the Stream Deck plugin would have to fetch it, or
the extension would have to inline it as a data URL over the wire. Flag for #111.

### 2.4 What Google tells us about the accessibility tree

This is the strongest primary-source evidence available without logging in, and it is
unusually good. From
[Use Google Chat with a screen reader (Computer)](https://support.google.com/chat/answer/7652236?hl=en&co=GENIE.Platform%3DDesktop):

> As you move through the Left navigation area, you're told if there are unread messages for
> the direct message or Space.

> Up or down arrow to select a Shortcut section, Direct message conversation, or Space

> **Shift + Up or Down arrow to move to previous or next unread conversation**

> Press `h` then `c` to move focus to Direct messages
> Press `h` then `r` to move focus to Spaces

and, for the message list rather than the roster:

> If the message is a thread with unread replies, the beginning of the output is
> `<nn> unread` followed by the sender and message.

Four conclusions, none of them requiring a selector:

1. **Unread state is in the accessibility tree for roster rows.** "You're told if there are
   unread messages" is a promise about the accessible name/description of the row. It is
   therefore in the DOM as text, `aria-label`, or `aria-describedby` — not purely as a CSS
   `font-weight`.
2. **Chat has a per-row unread *predicate*.** `Shift + Up/Down` = "previous/next unread
   conversation" cannot be implemented without one. Whether that predicate is *reflected*
   into the DOM (a class, an attribute) or lives only in JS state is the open question.
3. **`<nn> unread` is a real string in Chat's a11y vocabulary** — but the documented instance
   is about **threads in a message list**, not roster rows. Do **not** assume the roster uses
   the same phrasing. It is a lead for §5.6, not a finding.
4. **`h`+`c` and `h`+`r` give a free, selector-free way to land focus inside each list** —
   §5.5 exploits exactly this to make Chat itself point at its own roster rows.

### 2.5 Verdict on (b)

**Settled:** a stable id exists (`spaces/{space}` ≡ the URL id), the navigable URL grammar,
the fact that display name may be absent, and the fact that no server-side unread *count*
exists in the public model.

**Not settled:** whether the roster row exposes that id in the DOM at all. The natural shape
is an `<a href="/room/<id>">` or `<a href="/dm/<id>">`, which would settle id + navigability
in one attribute — but Chat is a heavily virtualised app and may well render rows as
`role="option"` `<div>`s with no href. **Run §5.5.** This is the single highest-value
unknown in the whole note: if there is no href and no `data-*` id, the roster's stable
identity has to come from the display name, which is neither stable nor unique.

---

## 3. Unread vs notifying

**This is the sub-question that primary sources answer best**, because Google documents the
product semantics precisely even though it documents nothing about the DOM.

### 3.1 The notification levels

From [Customize notification frequency with more options in Google Chat and Chat in Gmail](https://workspaceupdates.googleblog.com/2021/03/customize-notification-frequency-in-google-chat-and-gmail.html)
(Google's own release-notes blog), verbatim:

> **Notify always:** You'll receive a notification for every message and new messages will be
> badged.
>
> **Notify less:** You'll receive notifications and badges for direct mentions, @all
> mentions, and followed threads.
>
> **Notifications off:** You will receive no notifications, but you'll see a badge if you're
> directly mentioned.

The current help-centre wording for spaces with inline threading
([Turn Google Chat notifications on or off](https://support.google.com/chat/answer/7655718?hl=en&co=GENIE.Platform%3DDesktop))
renames these to **All** / **Main conversations** / **For you** / **None**, with:

> **None:** No notifications, just an indicator for @mentions.

### 3.2 Mute is a separate axis from notification level

From [Manage conversations by muting notifications in Google Chat](https://workspaceupdates.googleblog.com/2023/12/mute-notifications-google-chat.html),
verbatim:

> Muted conversations will not send push notifications, will not appear in home, and will
> also be visually deprioritized by being moved to the bottom of each conversation section.

> **Notification badges will still apply to muted conversations when there are new @ mentions
> for you or everyone in the conversation.**

and from the help centre, on the per-conversation mute checkbox:

> To prevent the conversation from being bolded and moved to the top of your conversation
> list, select the box next to "Mute conversation."

### 3.3 The four-quadrant table this produces

Combining the above, "bolded" and "badged" are **independent axes in Google's own model**,
and *both* off-diagonal quadrants are documented as reachable:

| | **Badged** | **Not badged** |
|---|---|---|
| **Bolded (unread)** | Default conversation with new messages | **Notifications off / "None"** with new non-mention messages — *this is the ticket's "muted spaces accumulate the former without the latter"* |
| **Not bolded** | **Muted** conversation with a new @mention (explicitly documented above) | Fully read, or muted with ordinary new messages |

Note the ticket's framing is slightly off: it is **"Notifications off"**, not **mute**, that
produces bold-without-badge. Mute suppresses *bolding itself*. So a muted space with ordinary
traffic is invisible on **both** axes — which is convenient for the map, since it means mute
alone never inflates a bold-based count either.

### 3.4 Verdict on (c)

**Settled:** the two states are genuinely distinct concepts in the product, they diverge in
both directions, and Google documents which settings produce which divergence. A DOM that
faithfully renders this product must encode both — a client that could not tell them apart
could not draw the UI.

**Not settled:** whether they are *separably readable*. The realistic risk is that the
distinction is carried by **CSS only** — bold via a class that maps to `font-weight: 700`,
badge via a distinct element. In that case the badge is separable (it is a distinct node)
but bold-unread is only readable via `getComputedStyle().fontWeight`, which is fragile and
would be an unpleasant thing to put in a `SelectorConfig`. §2.4's finding — that unread state
is announced to screen readers — argues **against** the CSS-only worst case for the *unread*
axis. **Run §5.7.**

---

## 4. Does this threaten the map's decision?

#104 settled: *"'Unread' means what Chat itself badges — muted spaces do not light the key."*

**Feasibility: no threat found, and one supporting finding.** Nothing discovered suggests the
badge is unreachable. Badges are, by their nature, *rendered elements* — they must be a node
with a number or a dot, which is far easier to select reliably than a font weight. If
anything, "mirror what Chat badges" is the **easier** of the two options to implement, because
§3.4's CSS-only risk applies to the bold axis, not the badge axis.

**Semantics: one real wrinkle, worth a line in the spec.** A badge count does not mean the
same thing on every conversation:

- On **Notify always / "All"**, the badge tracks **new messages**.
- On **Notify less / "Main conversations" / "For you"**, badges apply to
  "direct mentions, @all mentions, and followed threads" — so the number counts **mentions**,
  not messages.
- On **Notifications off / "None"** and on **muted** conversations, a badge appears **only**
  for @mentions.

So `sum(badge counts)` is a heterogeneous quantity: "things Chat thinks you should look at",
not "unread messages". That is arguably *exactly* what a summary key should show, and it is
consistent with the map's intent — but the spec should say so explicitly rather than call the
number "unread messages", or the key will be accused of lying whenever a `Notify less` space
has 40 unread and badges 1.

**One structural risk to flag for #111.** Muted conversations "will not appear in home" and are
"moved to the bottom of each conversation section". If the Chat UI *virtualises* the roster
list (likely for a long roster), rows below the fold may not exist in the DOM at all, and a
count derived by summing visible rows would be **silently short**. This is a real threat to
roster *completeness* — orthogonal to the badge/bold question, but it must be checked. §5.8.

**A second, smaller risk.** §2.2 established there is no server-side unread count. If Chat's
roster renders only a **dot** (not a number) for some conversation types, the per-conversation
count field in the wire roster is unfillable for those rows and the summary key can only count
*conversations*, not messages. §5.6 settles it. Note #104's own pitch already says the summary
key renders "`length`/sum" — `length` (conversation count) is the fallback that survives this.

---

## 5. Investigation procedure

Everything below is runnable by the user against a live authenticated Chat window. It is
ordered so the cheap, zero-code checks come first.

### 5.1 Path A (recommended first): DevTools console, no repo changes

The fastest route needs no extension, no bridge, no build. Open `https://chat.google.com/`
signed in, then `⌥⌘I` → Console.

If Chat is running as an **installed app/PWA window** (no menu bar), reach DevTools via
`chrome://inspect/#pages` → *inspect* next to the Chat entry. (#104 already lists PWA
content-script lifecycle as an open question; for *investigation* purposes the PWA window is
inspectable exactly like a tab.)

Path B (§5.9) reproduces the same answers through the repo's dev bridge, which is what you
want once you are writing the actual `SelectorConfig`.

### 5.2 What the devbridge already gives you for free

Verified by reading the source — `packages/extension/src/plugins/debug-plugin.ts`:

- `DebugPlugin` is **entirely platform-agnostic**. It takes a `Document` and runs
  `querySelectorAll` / `click` against it. There is not one Meet-specific line in it.
- It is registered by `loadPlugins()` whenever `import.meta.env.MODE !== "production"`
  (`packages/extension/src/plugins/index.ts`).

So the debug ops (`/dump`, `/query`, `/click`) work on *any* page the content script reaches.
Three limits to know before you rely on them (all in `debug-plugin.ts`):

```ts
const DUMP_SELECTOR = "button, [role='button'], [aria-label], [data-is-muted]";
const MAX_CONTROLS = 400;
const MAX_TEXT = 80;
const MAX_HTML = 300;
```

- A bare `/dump` only sees buttons and `[aria-label]` nodes. **A Chat roster row may well be
  a `role="option"` or `role="listitem"` with no `aria-label`, in which case `/dump` will not
  see it at all.** Use `/query?selector=…` for the roster.
- `outerHTML` is truncated to **300 characters** — far too short to capture a roster row's
  structure. For structural work, prefer Path A.
- `MAX_CONTROLS = 400` will silently clip a long roster.

### 5.3 What you must change to point the bridge at Chat

Three edits, all in `packages/extension/`:

1. `manifest.config.ts` — add a second `content_scripts` entry:
   ```ts
   {
     matches: ["https://chat.google.com/*"],
     js: ["src/content-script.ts"],
     all_frames: true,
     run_at: "document_idle",
   }
   ```
2. `manifest.config.ts` — add `"https://chat.google.com/*"` to `host_permissions`.
3. Rebuild with `just build-extension-debug` (MODE=`debug` keeps `DebugPlugin`; a production
   build strips it and the debug channel times out by design — see `docs/development.md`).

**Two hazards, both verified from source:**

- 🔴 **The dev bridge is single-client.** `DebugBridge.#onExtension` does
  `this.#ext?.close(); this.#ext = conn;` — a second connection **closes the first**. With a
  Meet tab and a Chat window both running the content script, they will endlessly evict each
  other and reconnect. **Close every `meet.google.com` tab for the duration of this
  investigation.** (This is also independent evidence for #106's multi-client bridge work — it
  is not a small change.)
- 🟡 With `all_frames: true`, *each matching frame* runs `init()` and opens its own socket.
  Same eviction problem, from one window. If §5.4 shows multiple same-origin Chat frames,
  temporarily set `all_frames: false` to isolate the top frame, or gate `init()` on
  `window.top === window` while investigating.
- 🟡 The Meet plugins (`newCorePlugin` etc.) will load on the Chat page. Reading
  `core-plugin.ts`, `installHooks` only subscribes to a model that will observe nothing, so it
  is **expected** to no-op — but this is **unverified**. If the Chat page console shows
  exceptions from the Meet model, split out a minimal debug-only content script that calls
  `loadPlugins()` with just `newDebugPlugin()`.

### 5.4 Settle reachability (row 13)

In the Chat window's DevTools console, **top frame**:

```js
// 1. Is the app actually framed at all?
console.log("frames:", window.frames.length, "isTop:", window.top === window);

// 2. Enumerate every frame element and its origin.
console.table([...document.querySelectorAll("iframe,frame")].map(f => ({
  src: f.src || "(about:blank)",
  origin: (() => { try { return new URL(f.src).origin; } catch { return "-"; } })(),
  name: f.name, id: f.id, cls: f.className,
  w: f.clientWidth, h: f.clientHeight, hidden: f.hidden || f.clientWidth === 0,
})));

// 3. Confirm the roster is reachable from THIS document, not a child frame.
//    (Use the documented shortcut in 5.5 first, then:)
console.log("roster in top doc?", document.activeElement !== document.body);
```

Cross-check in **DevTools → Application → Frames** (a tree of every frame with its URL and
security origin) — that is the authoritative view and needs no code.

**Record:** the count of frames, each frame's origin, and whether any *visible, non-zero-size*
frame is same-origin `chat.google.com`. Then confirm the header claim on the real page:

```sh
# Network tab → the document request for chat.google.com → Response Headers.
# Confirm X-Frame-Options is still SAMEORIGIN when authenticated (§1.2 caveat).
```

**Decision rule:** if all `chat.google.com` frames are hidden/zero-size and the roster is in
the top document, `all_frames: false` suffices and the client is simpler. Otherwise keep
`all_frames: true` and add a "which instance owns the socket" rule.

### 5.5 Settle identity (row 14) — let Chat point at its own rows

The trick is to use Google's **documented** keyboard shortcuts (§2.4) so you never have to
guess a selector. In the console, with the Chat window focused:

```js
// Paste this helper first.
function probe(label) {
  const el = document.activeElement;
  console.group(label);
  console.log("tag/role:", el.tagName, el.getAttribute("role"));
  console.log("id-ish attrs:", Object.fromEntries(
    [...el.attributes].map(a => [a.name, a.value])));
  console.log("closest link:", el.closest("a")?.getAttribute("href")
                            ?? el.querySelector("a")?.getAttribute("href") ?? "(none)");
  console.log("accessible text:", el.innerText.replace(/\s+/g, " ").slice(0, 200));
  console.log("ancestor chain:", (function up(n, out = []) {
    while (n && out.length < 8) { out.push(`${n.tagName}[role=${n.getAttribute("role")}].${n.className}`); n = n.parentElement; }
    return out;
  })(el).join("  <  "));
  console.log("outerHTML:", el.outerHTML);   // full, untruncated
  console.groupEnd();
  return el;
}
window.__probe = probe;
```

Then, **clicking into the page first so focus is in the app**:

1. Press `h` then `c` (documented: *move focus to Direct messages*). Run `__probe("DM list")`.
2. Press `↓` a few times to walk individual DM rows. Run `__probe("DM row")` on each.
3. Press `h` then `r` (documented: *move focus to Spaces*). Then `↓`. Run `__probe("Space row")`.

**What to record, per row:**

| Question | Where to look in the probe output |
|---|---|
| Is there an `href`? Does it match `/(u/\d+/)?(room\|dm)/<id>` (§2.1)? | `closest link` |
| Is there a `data-*` id, or a `jsdata`/`jscontroller` value containing an opaque token? | `id-ish attrs` |
| **Does the id survive a full page reload?** | Re-run steps 1–3 after `location.reload()` and diff the ids. **This is the actual "stable identity" test — do not skip it.** |
| Does the id match the API's `spaces/{space}` id? | If you have an API token, cross-check one against `spaces.list`. Optional. |
| Display name — own element, or mixed into row text? | `accessible text`, `outerHTML` |
| Avatar — `<img src>` (which origin?) or a synthesised initial `<div>`? | `outerHTML` |
| Is a **group DM** on `/dm/` like a 1:1? (§2.2's three-way `spaceType` vs two-way URL) | Compare a 1:1 row and a group-chat row |
| Is the row's container list identifiable (a `role="list"` / `role="listbox"` ancestor)? | `ancestor chain` — **this is the seed selector for the roster scan** |

### 5.6 Settle the unread count (row 15)

With focus in the roster, use the documented unread-navigation primitive:

```js
// Shift+Down = "move to next unread conversation" (documented, §2.4).
// Press it manually, then:
const unread = __probe("UNREAD row");

// Now compare against a definitely-read row:
// (press Down/Up to land on a read one, then)
const read = __probe("READ row");

// Structural diff — this is the money shot: what does an unread row have
// that a read row does not?
function shape(el) {
  return [...el.querySelectorAll("*")].map(n =>
    `${n.tagName}[role=${n.getAttribute("role")}][aria-label=${n.getAttribute("aria-label")}]`
    + `{${(n.textContent||"").trim().slice(0,24)}}`);
}
console.log("only in unread:", shape(unread).filter(s => !shape(read).includes(s)));
console.log("only in read:",   shape(read).filter(s => !shape(unread).includes(s)));
```

**Record:** whether the unread-only nodes contain a **number**, a **dot with no number**, or
neither. Then check `aria-label` / `title` / `aria-describedby` on both the row and the
unread-only node — §2.4 says the unread fact is announced, so *something* must carry it.

Sanity-check against a conversation you can control: send yourself 3 messages from your phone
and confirm the number goes 1 → 2 → 3, rather than staying a dot.

### 5.7 Settle unread-vs-notifying separability (row 16)

This needs you to *construct* the four quadrants of §3.3. Budget ~10 minutes; you need a space
you can freely receive messages in.

| Step | Setup | Expected product state | What to capture |
|---|---|---|---|
| 1 | A space at default notification level, with new ordinary messages | **bold + badged** | `__probe` the row, save `outerHTML` |
| 2 | Same space, set notifications to **"None" / "Notifications off"**, receive an ordinary (non-mention) message | **bold, NOT badged** | `__probe`, diff against step 1 |
| 3 | Same space, still "None", have someone **@mention you** | **badged** | `__probe`, diff |
| 4 | **Mute** the conversation (the "Mute conversation" checkbox), receive an ordinary message | **not bold, not badged, sorted to bottom** | `__probe`; confirm the row moved section |
| 5 | Still muted, receive an **@mention** | **not bold, BUT badged** (explicitly documented, §3.2) | `__probe`, diff against step 4 |

The critical diff is **step 1 vs step 2** (is bold separable from badge?) and **step 4 vs step
5** (is badge separable from bold?). For each, record:

```js
// Is "bold" a class/attribute, or CSS-only?
const nameEl = /* the row's display-name node from 5.5 */;
console.log("fontWeight:", getComputedStyle(nameEl).fontWeight);
console.log("classes:", nameEl.className, nameEl.closest("[role]")?.className);
console.log("aria on row:", [...row.attributes].filter(a => a.name.startsWith("aria-")));
```

**Decision rule for the map:**
- If the badge is a distinct element in steps 1/3/5 and absent in 2/4 → the map's
  "mirror what Chat badges" decision is **implementable as written**. ✅
- If bold is *only* `font-weight` with no class/aria difference → note it, but it does **not**
  block the map, because the map does not need bold. It would only block a future
  "all unread including muted" mode.
- If badge and bold share a single node with no distinguishing attribute → **the map's decision
  needs revisiting**, per #105's own escape clause. Report this immediately.

### 5.8 Settle roster completeness (the virtualisation risk, §4)

```js
// Count what's in the DOM vs what you can see by scrolling.
const rows = document.querySelectorAll(/* the roster-row selector found in 5.5 */);
console.log("rows in DOM:", rows.length);
// Now scroll the roster list container to the bottom and re-run.
// If the number changes, the list is VIRTUALISED and a DOM sum is incomplete.
```

Also check whether Chat renders an **aggregate** unread indicator (the favicon, the
`document.title`, or a header element). #104 rejected the tab title as a *data source* because
it cannot grow into paging — but it is an excellent **cross-check** for whether your roster sum
is complete:

```js
console.log("title:", document.title);
console.log("favicon:", document.querySelector("link[rel*=icon]")?.href);
```

If `document.title` says `(7) Google Chat` and your roster sum says 3, you have a
virtualisation bug. Record the exact title format either way.

### 5.9 Path B: the same answers through the dev bridge

Once §5.3's manifest edits are in and `just build-extension-debug` has run, with the Meet tab
closed and `just dev-bridge` running (binds `:2395`; the Stream Deck plugin must be stopped):

```sh
curl 'localhost:2397/health'                                   # is the Chat content script connected?
curl 'localhost:2397/query?selector=%5Brole%3D%22listitem%22%5D' | jq '.count'
curl 'localhost:2397/query?selector=%5Brole%3D%22option%22%5D'   | jq '.controls[0]'
curl 'localhost:2397/dump?q=unread'                            # any accessible name containing "unread"
curl 'localhost:2397/dump?q=new%20message'
curl "localhost:2397/query?selector=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("a[href^=\"/room/\"], a[href^=\"/dm/\"]"))')" | jq '.controls[].attrs.href'
```

That last one is the direct test of §2.5's key hypothesis: **do roster rows carry `/room/` or
`/dm/` hrefs?** If it returns a non-empty list, identity is solved and the `SelectorConfig`
seed writes itself.

Remember `MAX_HTML = 300` (§5.2) — use Path A when you need full structure. If you find
yourself wanting more, the honest fix is to raise `MAX_HTML` in `debug-plugin.ts` for the
duration, or add a `describeDeep` op; both are dev-only code and cost nothing shipped.

### 5.10 Reporting template

Paste this back into #105 so #110/#111 can start:

```
(a) Reachability
    frames on chat.google.com: N (list origins + sizes)
    roster frame: top | same-origin child at <url>
    all_frames needed: yes/no
    X-Frame-Options on authenticated doc: <value>

(b) Identity
    roster row selector (ancestor chain): <...>
    stable id source: href | data-attr | NONE
    id survives reload: yes/no
    url grammar observed: /room/<id> | /dm/<id> | other
    group DM path: /dm/ | other
    display name node: <...>
    avatar: <img src=origin> | initial-div | none
    per-conversation count: number | dot-only | none

(c) Unread vs notifying
    step 1 (bold+badge) row HTML: <...>
    step 2 (bold, no badge) diff: <...>
    step 5 (badge, no bold) diff: <...>
    badge node selector: <...>
    bold signal: class | aria | computed-font-weight-only
    SEPARABLE: yes/no      <-- if no, #104's decision needs revisiting

(extra) roster virtualised: yes/no    document.title format: <...>
```

---

## 6. Open questions this note does not answer

Ordered by how much they change the design:

1. **Does a roster row carry a DOM-readable stable id?** (§5.5) If not, the wire roster's
   `id` field has no source and #111 must redesign around display names — which are neither
   unique nor stable. **Highest impact by a wide margin.**
2. **Are badge and bold separable in the DOM?** (§5.7) #105's own escape clause: if not,
   #104's "mirror what Chat badges" decision must be revisited.
3. **Is the per-conversation unread a number or a dot?** (§5.6) Determines whether the summary
   key can sum messages or only count conversations. §2.2 proves there is no server-side
   number to fall back on.
4. **Is the roster virtualised?** (§5.8) A virtualised list makes any DOM-derived total
   silently wrong for long rosters — a correctness bug that would look like flakiness.
5. **Top frame or child frame?** (§5.4) Bounded to "same-origin either way" by §1, so this is
   an implementation detail — but it decides whether the client needs a socket-ownership rule.
6. **Does the Meet plugin set load harmlessly on a Chat page?** (§5.3) Affects only whether
   #110 can share one content script or needs a separate entry point.
7. **What does `document.title` look like, and does it agree with the roster sum?** (§5.8) Not
   a data source per #104, but the cheapest possible correctness oracle.
8. **Chat-in-Gmail.** (§1.4) A user who reads Chat inside Gmail is on `mail.google.com` and
   this feature will not see them at all. Out of scope for #104, but should be an explicit
   non-goal in the spec rather than a silent gap.

## Sources

- [Chrome for Developers — `content_scripts` manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts) — `all_frames`, `match_about_blank`, `match_origin_as_fallback`, per-frame URL matching
- [Chrome for Developers — Content scripts (concepts)](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) — isolated worlds, injecting in related frames
- [Google Chat API v1 — `spaces` REST resource](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces) — `name` format `spaces/{space}`, `spaceUri`, `spaceType`, `displayName`
- [Google Chat API v1 — `users.spaces.getSpaceReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces/getSpaceReadState) — `users/{user}/spaces/{space}/spaceReadState`
- [Google Chat API v1 — `SpaceReadState` schema](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces#SpaceReadState) — `name` + `lastReadTime` only; **no unread count**
- [Google Chat API v1 — `users.spaces.threads.getThreadReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces.threads/getThreadReadState)
- [Google Chat API v1 — `spaces.findDirectMessage`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/findDirectMessage) — DM lookup is by `users/{user}`
- [Google Chat guide — Create a named space](https://developers.google.com/workspace/chat/create-spaces) — `https://mail.google.com/chat/u/0/#chat/space/1234567`
- [Google Chat guide — Get details about a space](https://developers.google.com/workspace/chat/get-spaces) — "You can obtain the ID by calling the `ListSpaces` method **or from the space's URL**"
- [Google Chat Help — Use Google Chat with a screen reader (Computer)](https://support.google.com/chat/answer/7652236?hl=en&co=GENIE.Platform%3DDesktop) — left-navigation unread announcement, `Shift + ↑/↓` unread navigation, `h`+`c` / `h`+`r` focus shortcuts, `<nn> unread`
- [Google Chat Help — Turn Google Chat notifications on or off (Computer)](https://support.google.com/chat/answer/7655718?hl=en&co=GENIE.Platform%3DDesktop) — All / Main conversations / For you / None; the "Mute conversation" checkbox and its effect on bolding
- [Google Workspace Learning Center — Tips to use notifications in chats & spaces](https://support.google.com/a/users/answer/13682953) — per-conversation notification menus, thread unread counts, red-dot indicator
- [Google Workspace Updates — Customize notification frequency in Google Chat and Gmail (2021-03)](https://workspaceupdates.googleblog.com/2021/03/customize-notification-frequency-in-google-chat-and-gmail.html) — Notify always / Notify less / Notifications off, and what each badges
- [Google Workspace Updates — Manage conversations by muting notifications in Google Chat (2023-12)](https://workspaceupdates.googleblog.com/2023/12/mute-notifications-google-chat.html) — mute suppresses bold/home/push but **still badges @mentions**
- [Google Workspace Updates — Google Chat 'Rooms' are now 'Spaces' (2021-09)](https://workspaceupdates.googleblog.com/2021/09/google-chat-rooms-are-now-spaces.html) — the rename that explains why the route is still `/room/`
- [Google Workspace Updates — Preview summaries of unread conversations in the Chat home view (2024-10)](https://workspaceupdates.googleblog.com/2024/10/gemini-summaries-google-chat.html) — "unread group conversation, space, or thread" as a first-class UI category
- **Live unauthenticated HTTP probes** of `https://chat.google.com/*` and
  `https://mail.google.com/chat/*` (2026-08-23) — `X-Frame-Options`, CSP `frame-src`/`img-src`,
  `Cross-Origin-*` headers, and the login-redirect route oracle. Commands to reproduce are
  inline in §1.2, §1.3 and §2.1.
- Repo source, read directly: `packages/extension/src/plugins/debug-plugin.ts`
  (platform-agnostic `Document` ops; `DUMP_SELECTOR`, `MAX_CONTROLS`, `MAX_HTML`),
  `packages/extension/src/plugins/index.ts` (`MODE !== "production"` gating),
  `packages/extension/manifest.config.ts` (current `matches` / `host_permissions`),
  `packages/devbridge/src/debug-bridge.ts` (`#onExtension` — single-client eviction),
  `packages/devbridge/src/http-server.ts` (route list), `docs/development.md`
