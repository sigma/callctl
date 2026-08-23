# Spec: Google Chat unread deck key

**Status:** implementable handoff spec — ready to build.
**Origin:** wayfinder map [Map: Google Chat unread](https://github.com/sigma/callctl/issues/104) (#104).
This document is the synthesis deliverable of [Write docs/spec/chat.md](https://github.com/sigma/callctl/issues/111) (#111).
It stitches together already-made decisions (#105–#110, #112, #113, #117); it does **not**
introduce new ones. Every non-trivial claim traces back to a closed ticket — see
[§13 Traceability](#13-traceability).

Two decisions outlive this feature and live as ADRs rather than here:
[ADR 0001 — multi-client capability handshake](../adr/0001-multi-client-capability-handshake.md)
and [ADR 0002 — surface-neutral extension core](../adr/0002-surface-neutral-extension-core.md).

---

## 1. Overview

A new Stream Deck action — **`ChatUnreadAction`** — showing how many Google Chat
conversations are waiting, and raising the Chat window when pressed.

1. A new content script on `chat.google.com` **observes the conversation roster** and pushes
   the unread set over the existing local bridge.
2. The key renders a **Chat glyph with a red count badge**, plus a label naming *which* Chat
   account it is.
3. **Press raises the Chat window** — via the connected client, or by launching the installed
   Chrome app when nothing is connected.

Multiple Chat windows (a work Chrome profile and a personal one) are a **first-class case**:
each is a separately addressable client, and each can drive its own key.

### Locked premises (do not re-litigate)

- **Data source = the Chat DOM**, scraped by a content script. *Not* the Chat REST API — that
  would require authenticating the plugin — and *not* the tab title, which carries no count
  (§4) and cannot grow into the paging key.
- **The count is of unread *conversations*, never messages.** No trustworthy message count
  exists anywhere: not in `SpaceReadState`, not in the roster DOM (§4).
- **Muted conversations never light the key.** Mute is a deliberate statement that a space
  should not interrupt, and a deck key is an interrupting surface.
- **Press raises the window only** — no navigation to a conversation.
- **A stale count is never shown.** When the bound client goes away, the count is discarded.
- **Summary key only.** A key that pages through unread conversations is a stated future
  goal; it is out of scope here, and §3/§9 note where it was left room.

---

## 2. Architecture & placement

```
Stream Deck app ──▶ @callctl/plugin ──┐
                    (ChatUnreadAction)│
                                      ├── @callctl/bridge ── ws :2395 ──▶ @callctl/extension
                    @callctl/devbridge┘   (client registry,              ├─ src/meet/  (content script)
                    (DebugBridge)         handshake, routing)            └─ src/chat/  (content script)
                                                                              │
                                                                     DOM read ▼
                                                                    chat.google.com
```

- **`@callctl/protocol`** gains `chat.ts` (§9) and `session.ts` (handshake, ADR 0001).
- **`@callctl/bridge`** is new: the shared multi-client connection registry, consumed by both
  `MeetRemote` and `DebugBridge` (ADR 0001).
- **`@callctl/extension`** grows `src/core/` and `src/chat/` beside `src/meet/` (ADR 0002).
- **`@callctl/plugin`** gains `ChatUnreadAction` and `src/chat/render.ts`, mirroring
  `src/calendar/render.ts`.

### Dependencies

Build order is forced: `protocol` → `bridge` → {`plugin`, `devbridge`}; `extension` depends on
`protocol` only.

---

## 3. The key face

Rendered as a 144×144 @2x SVG via `KeyAction.setImage`, mirroring
`packages/plugin/src/calendar/render.ts` (same field colour `#1c2128`, same font).

A **Chat speech-bubble glyph** is the subject; a **red circular badge** on the top-right
corner carries the count; a **label strip** sits along the bottom.

### The three states

| State | Field | Glyph | Badge |
|---|---|---|---|
| **No Chat client** | darker (`#15181c`) | grey, dimmed | none |
| **Connected, nothing unread** | normal (`#1c2128`) | **blue** | none |
| **Unread** | normal | **blue** | red, with the count |

**Quiet is the same blue as unread.** This is load-bearing, not cosmetic: it means **grey means
exactly one thing — no client**. An earlier draft dimmed quiet to grey and absent to a slightly
deeper grey, which left the "never show a stale count" rule resting on a dimming difference
invisible at 72 px.

**The trade to know:** quiet and unread now differ *only* by the badge — one cue where a
dimmed-grey quiet gave two. Acceptable because a red badge on a blue field is loud, but it
makes the badge load-bearing. It renders legibly at 1 and 2 digits; it would not at 3.

Red is kept despite `next-meeting` also spending red on its late-flash. The notification
convention won on instant legibility.

### The label

**Always shown**, defaulted to the account domain **with its TLD stripped** — `arbora`, not
`arbora.partners`; `gmail`, not `gmail.com`. First dot-label only, so `acme.co.uk` reduces to
`acme`.

This is legibility, not preference: at 72 px `arbora.partners` is cramped to unreadable while
`arbora` is comfortable. A user-set label overrides the derivation entirely (§6).

### Bound but absent

A key bound to a client that is not currently connected renders the **no-client** state. There
is no fourth visual: "nothing connected at all" and "my client specifically is away" are the
same thing from the key's point of view, and both are fixed by pressing it (§8).

### Room left for the paging key

Nothing on this face encodes conversation identity, so the future paging key can use the same
slot without renegotiating this one. The roster already carries per-conversation id and name
(§9) even though this face uses neither.

---

## 4. Unread semantics — what the count means

**The count is `conversations.filter(c => !c.muted).length`** — unread-**and-notifying**
conversations.

Google Chat treats "unread" and "notifying" as independent axes: muting suppresses bolding but
still badges @mentions, while "Notifications off" suppresses badges but still bolds. Both
off-diagonal quadrants are documented by Google, and both are **separable in the DOM** (§5).

### There is no message count — twice over

- **API:** `SpaceReadState` carries only `name` + `lastReadTime`. No unread count exists in the
  public model.
- **DOM:** a per-conversation element does exist —
  `<span class="cPjwNc" role="presentation">1 Notification</span>`, plus an `aria-hidden`
  visual badge — but **every observation reads `1`**, including a conversation where the
  *oldest* message was deliberately marked unread and several should have been outstanding.

So the element is present but not usable as a message count. If a genuine `N > 1` is ever
observed, revisit — but the key counts conversations.

> ⚠️ A previous conclusion that "no count element exists at all" was **wrong**: that search ran
> while every conversation was read, so nothing was rendered, and an absent *state* was
> mistaken for an absent *element*. Recorded because the failure mode recurs.

### The tab title carries nothing

`document.title` was `"Global Announcements - Chat"` with unread conversations present. Any
title-scraping approach is dead on its own terms.

---

## 5. Reading the roster from the DOM

### Reachability

The roster is in the **top frame**. `chat.google.com` sends `X-Frame-Options: SAMEORIGIN`, and
while it *does* frame `ogs.google.com`, `accounts.google.com` and
`myaccount.google.com/profile-picture`, the roster is not in any of them.

**`all_frames: false`.** One host permission, `https://chat.google.com/*`.

### Rows and identity

A conversation row is **`[data-group-id][role="listitem"]`**, carrying:

```html
<span role="listitem" class="…" jsname="CmABtb"
      id="dm/3aSmhKAAAAE/SCcFR"
      data-group-id="dm/3aSmhKAAAAE"
      data-starred="true"
      data-display-timestamp="1787230544809">
```

- **`data-group-id` is the stable id**, and is the REST resource name modulo pluralisation:
  `space/AAQAr0bt0mg` ↔ `spaces/AAQAr0bt0mg`; `dm/<id>` for direct messages. It also appears as
  `data-hovercard-id` on an inner node and as the `id` prefix.
- `data-starred` = pinned; `data-display-timestamp` = epoch-ms, for ordering.
- **Non-conversation rows carry no `data-group-id`.** Suggested contacts, birthday cards and
  the "Ask Gemini" entry are also `role="listitem"` — a bare `role=listitem` query returned 28
  nodes for 16 conversations. `data-group-id` is both the id *and* the correct filter.

Routes, for reference: `/room/<id>` and `/dm/<id>` are real; **`/space/<id>` is not** — it
bounces to the app root. Named spaces still live under the pre-2021 `/room/` path.

### The unread discriminator

Read the **row's `innerText`**:

| Token rendered | Meaning |
|---|---|
| `Unread` | unread **and notifying** — counted |
| `Muted,` | unread but muted — reported, not counted |
| `N Notification` | unread either way (not a usable count, §4) |

Established by controlled A/B: one unread unmuted → 1 match; everything read → **0**; the same
conversation muted → the `Muted,` form only; unmuted again → back. Only the mute setting
changed between the last two, so the split is causal.

> 🔴 **The trap.** `<span class="mL1cqe"> Unread </span>` is present on **every row** by
> `textContent` — including read rows and the row currently open — because it is CSS-hidden
> markup. **Read `innerText` on the row**, which is layout-aware. A scraper using `textContent`
> reports *everything* as unread.
>
> And read it **on the row, not the span**: `innerText` on an element that is itself
> `display: none` falls back to `textContent`, so querying the span directly still returns
> `"Unread"` for every row.

Equivalent generated classes exist (`H7du2` notifying, `mznwRb` muted) and reproduce the same
partition, but **must not be used**: Google regenerates them per deploy. They are recorded in
`docs/research/chat-roster-dom.md` §7 for diagnosis only.

`font-weight` is `400` on every row — boldness lives on an inner node, so a row-level computed
style is not a discriminator.

### Chat's own unread filter

Chat has a per-section **"Toggle unread filter"** (`[aria-label='Toggle unread filter']`, state
on `aria-checked`). While on, **only unread conversations render**.

This is harmless here **because we only ever report unread conversations** (§9) — the filter
hides read ones, which we do not send. It would matter to any feature that needed the whole
roster.

---

## 6. Client identity and label

Per ADR 0001, each extension install mints an **opaque string id** into
`chrome.storage.local`. Since that store is per-Chrome-profile, the id is a per-profile
identity, stable across reconnects.

### The label

Read from the Chat **top frame**, at **zero incremental permission** — the
`https://chat.google.com/*` host permission is already required for the roster:

```html
<a class="gb_C gb_9a gb_8" role="button"
   aria-label="Google Account: <Display Name>  &#10;(<local>@<domain>)">
```

Selector: **`a[role="button"][aria-label*="@"]`** — exactly one match document-wide.

🟢 **Selecting on `@` rather than the English `"Google Account:"` prefix makes this
locale-invariant**, since an address contains `@` in every locale. This is a *better* position
than the roster tokens are in (§7).

- `text` and `visibleText` are **both empty**: the identity is attribute-only, so §5's
  `innerText` technique does not apply here.
- Do **not** use the `gb_*` classes; they are generated.
- Extracting the address is **lexical token extraction, not parsing** — take the `@`-bearing
  token — the same justification `src/meet/location.ts` gives for its `MEETING_CODE` pattern.

The **domain** is the label; the plugin strips the TLD for display (§3).

### Fallback ladder

**user's own label → last-known-good cache → domain (`acme.com`) → local part → account index
(`Chat u/1`) → id stub (`Chat · 4f2a`)**.

`"Chat 1"` is explicitly rejected: an ordinal over connections is ADR 0001's already-rejected
auto-assign-by-slot, and a silently-swapped *label* is worse than a swapped binding because it
lies rather than fails.

The account index is obtainable from the top frame without cross-origin access — the OneGoogle
iframe's `src` is `https://ogs.google.com/u/0/widget/app?…`.

🔴 **The account index must never enter the client id** — it is session-dependent. See ADR 0001.

### Why not an extension API

`chrome.identity.getProfileUserInfo` reads `GetPrimaryAccountInfo` on the Chrome **profile**,
so it returns the *same string for both windows* in exactly the two-accounts-one-profile case
this exists to serve, and is silently wrong when Chrome is signed in as A while Chat is B. It
also needs `identity.email` — user-visible warning *"Know your email address"*, on an extension
that currently declares only `storage` and warns about nothing — and is not callable from a
content script. `cookies` costs `*://*.google.com/`; `getAccounts` is dev-channel-only; there
is no `chrome.profiles` API.

---

## 7. Selector configuration

Per ADR 0002, selectors are per-surface: separate type, separate storage key, separate ops.

```ts
export interface ChatSelectorConfig {
  selectors: { row: string; accountAnchor: string };  // querySelectorAll
  tokens:    { unread: string; muted: string };       // matched against row innerText
  attrs:     { groupId: string };                     // attribute name
}
```

**Structured by kind, not a flat `Record<key, string>`**: these are three different kinds of
value, and a flat record gives a reader no way to know `unread` is matched against rendered
text while `row` is passed to `querySelectorAll`.

Defaults are the values in §5, verified live 2026-08-23. All are overridable over the wire via
`chat.setSelectors`, applying on the next observation — no rebuild, no reload.

### 🟡 Locale

`tokens` are **English UI strings**. A non-English Chat renders `Non lus` and every signal
silently returns zero — the same failure mode as a renamed class, triggered by locale instead
of a deploy.

Mitigation is **diagnosis, not translation**: the client reports `document.documentElement.lang`
at handshake (§9), defaults are documented as `en`, and a mismatch is visible rather than
silent. Shipping non-English defaults needs a non-English session to discover them.

Deliberately **not** done: a locale-keyed token table (would ship with one row and a guess), and
a class-name cross-check (a token/class disagreement says one is stale but not which, doubling
the drift surface for an ambiguous signal).

---

## 8. Press → raise the window

Two tiers.

### Tier 1 — the bound client is connected

The plugin sends `chat.raise` to that client.

⚠️ **`chrome.windows` is not callable from a content script.** The content script must message
the service worker, which calls `chrome.windows.update({ focused: true })`. `background.ts` is
currently inert ("only logs") and gains this one responsibility. Whether basic `windows.update`
needs a manifest permission must be confirmed during implementation — it is believed not to,
but that was never verified.

### Tier 2 — no client connected

The plugin launches the installed Chrome app itself:

```
open -a "Google Chrome" --args --profile-directory=<profile> --app-id=<id>
```

- **A plain `chrome <url>` launch opens a tab, not the app window.** Command-line URLs navigate
  as `PAGE_TRANSITION_AUTO_TOPLEVEL`, which is excluded from navigation capturing, and
  `MaybeHandleWebAppLaunch` bails when `--app-id` is absent.
- `--app-id` is a shipping cross-platform switch and the one Chrome writes into its own
  generated shortcuts. **`--app=<url>` is the wrong switch** — new window every time, no
  installed-app lookup.
- It is a genuine **focus**, not a second window: Chat's manifest ships
  `"launch_handler": {"client_mode": "focus-existing"}`, honoured by `WebAppLaunchProcess`.
- `--profile-directory` composes with `--app-id`, which is why this beats the shim route
  (`open -b com.google.Chrome.app.<id>` — viable, but carries no profile selector).

**The app id is configuration, not computed.** The documented a–p SHA-256 derivation over Chat's
served manifest id yields a *different* value from the installed shim's. Read it from the shim's
`Info.plist` (`CrAppModeShortcutID`), from `chrome://web-app-internals`, or make it a setting.

🔴 **`openWithProfile` currently passes `-n`** (`packages/plugin/src/open/profile-open.ts`), which
`open(1)` documents as forcing a new instance — **wrong for a raise-the-window press**. Tier 2
must not use it. (Whether `-n` is also wrong for `next-meeting`'s tier-2 open is a separate
Meet-side question, out of scope here.)

### Degradation

**Chat not installed as an app** ⇒ no `--app-id` to launch ⇒ fall back to opening
`https://chat.google.com` in a tab. The window is raised in spirit, if not as an app window.

---

## 9. Wire contract

All payloads ride the existing envelope with `data` JSON-encoded as a string, the convention
`setSelectors` and `debug.ts` already use. `Message` is `{ event, data?, client? }` (ADR 0001).

### `protocol/chat.ts`

```ts
export const ChatCommand = {
  GetRoster:    "chat.getRoster",     // explicit resync
  Raise:        "chat.raise",         // no arguments
  SetSelectors: "chat.setSelectors",
  GetSelectors: "chat.getSelectors",
} as const;

export const ChatEvent = {
  Roster:    "chat.roster",
  Selectors: "chat.selectors",
} as const;

/** One unread conversation. Read conversations are never sent. */
export interface ChatConversation {
  /** `data-group-id` — the REST resource name modulo pluralisation. */
  id: string;
  name: string;
  /** Unread but muted: excluded from the badge, still reported. */
  muted: boolean;
}

export interface ChatRoster {
  conversations: ChatConversation[];
}
```

**Full snapshot of unread conversations on every change**, not a delta. The roster is tiny (16
conversations observed, 0–3 unread), so a delta protocol buys nothing and costs sequence
numbers plus a resync path after every reconnect; a snapshot is idempotent and self-healing.

**Unread-only** — read conversations are noise for both this key and the paging key, and sending
them leaks more of the chat list than the feature needs.

**No `count` field** (§4). **`muted` rides on the entry** rather than being filtered
extension-side, so the wire stays descriptive and the plugin decides what to count. **No
`avatar`** until the paging key needs one — additive.

**No completeness marker.** Unread-only sending neutralises the unread-filter risk entirely
(§5); that leaves virtualisation, which the extension cannot reliably detect — so a `complete`
flag would be guesswork the plugin would then trust. See §12.

### `protocol/session.ts` additions

The handshake carries, alongside the client id and derived ops (ADR 0001):

- **`label?: string`** — the **full domain** (`arbora.partners`). ⚠️ The plugin strips the TLD
  for display (§3); the wire deliberately carries a value the key never shows verbatim, so
  presentation stays next to the renderer and a future consumer (the Property Inspector
  dropdown, disambiguating `acme.com` from `acme.dev`) needs no wire change.
- **`lang?: string`** — `document.documentElement.lang`, defaults documented as `en` (§7).
- Both **optional and refinable**: account discovery may resolve late, so a client may handshake
  before it knows its label and refine afterwards. The plugin caches last-known-good.

### Behaviour

- **The client pushes the roster on connect**; `chat.getRoster` is resync only. Deliberately
  unlike Meet, which *asks* on connect because its state lives in a DOM it must query — the
  Chat client is already observing its roster continuously, so ask-then-answer would add a round
  trip and a window of stale-or-nothing.
- **Unread state pushes on DOM change** via `MutationObserver`. No polling. Meet re-renders
  controls and can swap `<body>`; assume Chat can too, so observe broadly from
  `document.documentElement` and re-scan.
- **`chat.raise` takes no arguments.** The paging key will add an optional target *additively*,
  needing no new command — so shipping the field now is unused API inviting use before its
  semantics are settled.
- **"No Chat client" is not expressible on the wire**, by construction: a disconnected client
  cannot send, so a going-away event is unreliable exactly when it matters (crash, tab close,
  sleep). The socket closing is the signal; the capability registry is the state.
  **Bound-but-absent** = the key's bound id is not in the connected set.

### 🔴 Wire breaks

1. **`Message` gains `client`** (ADR 0001).
2. **The handshake becomes mandatory** (ADR 0001).
3. **Every Meet op is prefixed** — `toggleMic` → `meet.toggleMic`, and so on, plus
   `meet.setSelectors` / `meet.getSelectors` / `meet.selectors`.

On (3): only the selector ops collide *today*, so this is insurance rather than necessity.
`toggleMic` is unique only because Chat has no mic — **the moment a second meeting platform
appears it collides**, at which point the rename is a wire break against a shipped third surface
rather than a mechanical diff. There is no compatibility cost now (handshake mandatory, both ends
ship together); there would be later. It lands inside ADR 0002's refactor.

---

## 10. Deck action & binding

`ChatUnreadAction` settings:

| Setting | Meaning |
|---|---|
| `clientId` | Which Chat client this key follows. **Empty = any client with the capability.** |
| `label` | Optional user override of the derived label (§6). |
| `appId` | The installed Chat app id for tier-2 launch (§8). |
| `profile` | Chrome profile directory for tier-2 launch. |

The Property Inspector lists **currently-connected clients** by label for the `clientId`
dropdown. Unbound is the default, so the single-profile case is zero-configuration; the
two-profile case is one selection per key.

**Not auto-assigned by connection order** — that depends on which window opened first, so work
and personal keys would silently swap.

Like `ToggleAction`, the key must set **`DisableAutomaticStates`** if it uses multi-state
imagery, and drive its visual from real state only.

---

## 11. Build order

1. **ADR 0002's refactor, on its own** — `src/core/`, `SurfacePlugin`, `ID()` split, `meet.*` op
   prefixing. Acceptance: *Meet still works, nothing else changed*.
2. **`@callctl/bridge`** + ADR 0001's handshake and routing; `MeetRemote` and `DebugBridge`
   both consume it. Acceptance: Meet still works with one client; two clients coexist.
3. **`protocol/chat.ts`** + the Chat content script and roster observer.
4. **`ChatUnreadAction`** + `plugin/src/chat/render.ts`.
5. **Tier-2 press** and the Property Inspector.

Steps 1 and 2 are pure refactor and carry no Chat code; a Meet regression in either is
unambiguous.

---

## 12. Known risks and untested ground

| Risk | Status |
|---|---|
| **Roster virtualisation** above ~16 conversations | Not virtualised at N=16 with a shortened window. Untested above that. If Chat virtualises a long roster, a DOM-derived count undercounts — fix in the extension (scroll/observe), not the wire (§9). |
| **Locale** | Tokens are English (§7). Mitigated by `lang` reporting, not solved. |
| **Content-script lifecycle in a Chrome *app* window** | Whether an installed-PWA window hosts content scripts with a tab's longevity, and how it reconnects, was never measured. All DOM observation was done in an ordinary tab. |
| **Account label timing** | The account anchor was present a few seconds after load; whether it exists at `document_idle` or needs an observer was not measured. Assume it may arrive late — hence the refinable label (§9). |
| **`[aria-label*="@"]` uniqueness** | Matched exactly once in the observed session. A different Chat state (an open mention autocomplete) could plausibly introduce another; the `role="button"` scoping mitigates. |
| **Two accounts in one profile** | The design accommodates it (opaque id, §6) but it was never observed — only one signed-in account was available. |
| **`windows` permission** | Believed unnecessary for `windows.update`, unverified (§8). |
| **`9+` badge cap** | Not specified. Observed magnitudes (16 conversations, 0–3 unread) say unnecessary; nothing bounds the count, so a busy roster is untested (§3). |

---

## 13. Traceability

| § | Decision | Ticket |
|---|---|---|
| 1, 4, 5 | Roster DOM: reachability, identity, unread vs notifying | [#105](https://github.com/sigma/callctl/issues/105), [#112](https://github.com/sigma/callctl/issues/112) |
| 5 | Semantic (class-free) unread signals; the `textContent` trap | [#113](https://github.com/sigma/callctl/issues/113) |
| 8 | Focusing an installed Chrome app window; `--app-id`; the `-n` flag | [#106](https://github.com/sigma/callctl/issues/106) |
| 2, 6, 9, 10 | Multi-client handshake, addressing, identity, binding | [#107](https://github.com/sigma/callctl/issues/107) → ADR 0001 |
| 2, 7, 11 | Extension core seam, selector split, sequencing | [#108](https://github.com/sigma/callctl/issues/108) → ADR 0002 |
| 3 | Key face, states, label | [#109](https://github.com/sigma/callctl/issues/109) |
| 9 | Wire contract | [#110](https://github.com/sigma/callctl/issues/110) |
| 6 | Account/domain discovery; why not `chrome.identity` | [#117](https://github.com/sigma/callctl/issues/117) |

**Research assets** (in-tree, primary sources):
[`docs/research/chat-roster-dom.md`](../research/chat-roster-dom.md),
[`docs/research/chat-account-identity.md`](../research/chat-account-identity.md),
[`docs/research/chrome-app-window-focus.md`](../research/chrome-app-window-focus.md).
**Prototype** (throwaway branch, primary source): `prototype/chat-key-face`.
