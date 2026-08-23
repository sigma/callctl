# How does the extension discover its own account or domain?

> Research asset for [Map: Google Chat unread](https://github.com/sigma/callctl/issues/104),
> ticket [#117](https://github.com/sigma/callctl/issues/117). Blocks
> [#110](https://github.com/sigma/callctl/issues/110) and
> [#111](https://github.com/sigma/callctl/issues/111).
> Downstream of [#107](https://github.com/sigma/callctl/issues/107) (client identity =
> opaque per-install id + **non-load-bearing** human label) and
> [#113](https://github.com/sigma/callctl/issues/113) (the `textContent` vs `innerText`
> lesson, which this note's investigation procedure applies).
>
> Primary sources: [`chrome.identity` API reference](https://developer.chrome.com/docs/extensions/reference/api/identity),
> [Chrome permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list),
> [Chrome content-scripts concepts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
> **Chromium source** (`identity_get_profile_user_info_function.cc`),
> [Google Identity — OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
> [Google Account Help — sign in to multiple accounts](https://support.google.com/accounts/answer/1721977?hl=en&co=GENIE.Platform%3DDesktop),
> [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/permissions),
> plus **direct unauthenticated HTTP probes of `chat.google.com`** (reproduced inline in
> §2.1 and §5.2) and the repo's own source.

---

> ⚠️ **§9 supersedes where it disagrees.** §1–§8 were written *without* a live session.
> §9 records real observations against a signed-in Chat tab and **confirms §5's route**:
> the account identity is in the **top frame** (not the cross-origin OneGoogle frame §5.2
> feared), on an `aria-label`, reachable with a **locale-independent** selector.

## 0. Verified vs. hypothesis — read this first

**The author of this note could not log into a Google account.** No live, authenticated Chat
DOM was inspected. **Nothing below is a class name, `aria-label`, or CSS selector invented to
look plausible.** Where a selector would be needed you will find an *investigation step*
instead (§6). The one section that is pure recommendation is §7, and it is labelled as such.

| # | Claim | Status |
|---|---|---|
| 1 | `getProfileUserInfo` returns an empty result unless the **`identity.email`** permission is declared — not merely `identity` | ✅ **Verified** — API reference + Chromium `HasAPIPermission(kIdentityEmail)`, §1.1–§1.2 |
| 2 | `identity.email` shows the user an install-time warning: *"Know your email address."* | ✅ **Verified** — Chrome permissions list, §1.1 |
| 3 | The value returned is the **browser profile's primary account** (`ConsentLevel::kSignin`), never a per-tab or per-window account | ✅ **Verified** — Chromium source, §1.2 |
| 4 | With default options the call returns **empty unless the profile syncs extensions**; you must pass `{ accountStatus: "ANY" }` | ✅ **Verified** — Chromium source + `AccountStatus` enum default `SYNC`, §1.3 |
| 5 | It returns an **error** in an incognito/OTR context | ✅ **Verified** — Chromium source `IsOffTheRecord()`, §1.3 |
| 6 | `chrome.identity` is **not** callable from a content script; it is not on the content-script API allowlist | ✅ **Verified** — Chrome content-scripts docs, §1.4 |
| 7 | `chat.google.com/u/<n>/` accepts **non-negative integers only**; `u/-1/` and `u/abc/` bounce to the app root | ✅ **Verified** — live route probe, §2.1 |
| 8 | Google documents the default account as *"the one you signed in with first"* — i.e. index order is **sign-in order**, not an account property | ✅ **Verified** — Google Account Help, §2.2 |
| 9 | Google publishes **no** mapping from an account index to an identity; no documented endpoint, no documented parameter | ✅ **Verified (negative)** — §2.2–§2.3 |
| 10 | `chrome.instanceID` identifies an **app instance**, not a user; costs the `gcm` permission | ✅ **Verified** — instanceID reference, §3 |
| 11 | `chrome.cookies` needs `"cookies"` **plus host permissions** for every host read | ✅ **Verified** — cookies reference, §3 |
| 12 | `chrome.identity.getAccounts()` (which would enumerate profile accounts) is **dev-channel only** | ✅ **Verified** — API reference, §3 |
| 13 | **No Chrome extension API exposes the browser profile's name or avatar.** There is no `chrome.profiles` | ✅ **Verified (negative)** — API index, §3 |
| 14 | The Workspace/Cloud-org domain is a first-class, documented identity claim (`hd`), but only reachable through an **OAuth ID token** | ✅ **Verified** — OpenID Connect reference, §4 |
| 15 | `chat.google.com`'s CSP `frame-src` allows `ogs.google.com`, `accounts.google.com` and `myaccount.google.com/profile-picture` — the OneGoogle account surface is a **cross-origin** frame candidate | ✅ **Verified** — live header probe, §5.2 |
| 16 | `document.title` on Chat carries no account identity | ✅ **Verified** — live observation recorded in [`chat-roster-dom.md` §7.4](chat-roster-dom.md) |
| 17 | The Chat page's **top frame** renders the signed-in address or domain somewhere readable at `document_idle` | 🔬 **HYPOTHESIS** — untested. Run §6.3 |
| 18 | If it is only in the account **menu**, the identity string lives in a cross-origin `ogs.google.com` frame and is unreadable under the Chat host permission alone | 🔬 **HYPOTHESIS** — (15) makes it plausible, unconfirmed. Run §6.4 |
| 19 | A Chat window signed into a non-default account always carries `/u/<n>/` in `location.pathname` | 🔬 **HYPOTHESIS** — the route *exists* (7), but whether the app keeps it in the address bar is unobserved. Run §6.2 |
| 20 | An `href` to `accounts.google.com` on the page carries the address in a query parameter (`Email=`, `authuser=`) | 🔬 **HYPOTHESIS** — a standard shape for Google sign-out links, **not verified here**. Run §6.3 |

**Rows 17–20 require a live authenticated session. §6 is the runnable procedure and is the
operative deliverable of this note.**

---

## TL;DR

1. **`chrome.identity.getProfileUserInfo` answers the wrong question, and it costs a warning
   to ask it.** It returns the *browser profile's* primary account. In the exact scenario
   #107 designed for — one Chrome profile signed into two Google accounts, two Chat windows
   at `/u/0/` and `/u/1/` — it returns **the same string for both**, so it cannot be the
   discriminator. It also needs `identity.email` (user-visible warning *"Know your email
   address"*), needs `{accountStatus:"ANY"}` or it silently returns empty, and is not callable
   from a content script. **Do not add it.** See [§1](#1-chromeidentitygetprofileuserinfo).
2. **The `/u/<n>/` index is a positional integer with no documented identity mapping.** The
   route grammar accepts any non-negative integer and rejects non-integers; Google documents
   that the default (index 0) is *"the one you signed in with first"*, which makes the index a
   property of the **session**, not of the account. It is a perfectly good *label of last
   resort* and an outright wrong *binding key*. See [§2](#2-the-un-account-index).
3. **Every other extension-API route is worse per unit of permission.** `cookies` +
   `*://*.google.com/` to read opaque Google session cookies is the worst trade in the set;
   `instanceID` identifies an install, not a user; `getAccounts` is dev-channel; there is no
   profile API at all. See [§3](#3-other-extension-api-routes-and-what-they-cost).
4. **The domain is the better label — but it is only *documented* as an OAuth claim.**
   Google's `hd` claim is *"The domain associated with the Google Workspace or Cloud
   organization of the user"*, present **only** for organization accounts. So "domain as the
   label" is right for work accounts and vacuous for consumer ones (`gmail.com` does not
   discriminate two personal accounts). Getting `hd` properly means an OAuth flow, which is a
   grotesque price for a label. Derive the domain from a discovered address instead. See
   [§4](#4-workspace-domain-vs-email-address).
5. **Recommendation: read the label off the page the content script is already on**, at
   **zero incremental permission cost** — `https://chat.google.com/*` is already required for
   the roster. The risk to check first is that the identity may live in a **cross-origin
   `ogs.google.com` frame** (Google's OneGoogle bar), which the Chat host permission does not
   reach. See [§5](#5-the-recommended-route-the-page-itself).
6. **Fallback ladder: `saved` → `domain` → `local-part` → `Chat u/<n>` → `Chat · <id[0:4]>`.**
   Explicitly **not** `"Chat 1"` — an ordinal over connections is exactly the auto-assign-by-slot
   scheme #107 already rejected, because connection order depends on which window opened
   first and the two keys silently swap. See [§7](#7-the-fallback-ladder-recommendation).

---

## 1. `chrome.identity.getProfileUserInfo`

### 1.1 The permission is `identity.email`, and it is a warning permission

The [`chrome.identity` reference](https://developer.chrome.com/docs/extensions/reference/api/identity)
lists `identity` as the API's permission, but the method's own contract is stricter. Verbatim,
from the `ProfileUserInfo` type:

> `email: string` — An email address for the user account signed into the current profile.
> Empty if the user is not signed in **or the `identity.email` manifest permission is not
> specified**.

> `id: string` — A unique identifier for the account… Empty if the user is not signed in or
> (in M41+) **the `identity.email` manifest permission is not specified**.

and on the method:

> **Requires the `identity.email` manifest permission. Otherwise, returns an empty result.**

From the [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list),
verbatim:

> `"identity"` — Gives access to the `chrome.identity` API.
>
> `"identity.email"` — Gives access to the user's email address through the `chrome.identity`
> API. **Warning displayed: _Know your email address._**

That is the whole cost in one line. The extension today declares
`permissions: ["storage"]` and `host_permissions: ["https://meet.google.com/*"]`
(`packages/extension/manifest.config.ts`) — a permission set with **no install-time warning at
all**. `identity.email` would be the first, and it would be there to render a dropdown entry.

Weigh that against the Chrome Web Store
[permissions policy](https://developer.chrome.com/docs/webstore/program-policies/permissions),
verbatim:

> Request access to the narrowest permissions necessary to implement your Product's features
> or services.

> If more than one permission could be used to implement a feature, you must request those
> with the least access to data or functionality.

§5's route implements the same feature with **no** additional permission. By the policy's own
"least access" test, `identity.email` is therefore disallowed for this purpose, not merely
inadvisable.

### 1.2 What it actually returns — the Chromium implementation

From `chrome/browser/extensions/api/identity/identity_get_profile_user_info_function.cc`
([Chromium source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/identity/identity_get_profile_user_info_function.cc)),
verbatim:

```cpp
ExtensionFunction::ResponseAction IdentityGetProfileUserInfoFunction::Run() {
  if (browser_context()->IsOffTheRecord()) {
    return RespondNow(Error(identity_constants::kOffTheRecord));
  }

  const std::optional<api::identity::GetProfileUserInfo::Params> params =
      api::identity::GetProfileUserInfo::Params::Create(args());
  EXTENSION_FUNCTION_VALIDATE(params);

  api::identity::ProfileUserInfo profile_user_info;
  if (extension()->permissions_data()->HasAPIPermission(
          mojom::APIPermissionID::kIdentityEmail)) {
    Profile* profile = Profile::FromBrowserContext(browser_context());
    const CoreAccountInfo account_info = GetAccountInfoFromProfileDetails(
        params->details, IdentityManagerFactory::GetForProfile(profile),
        SyncServiceFactory::GetForProfile(profile));

    profile_user_info.email = account_info.email;
    profile_user_info.id = account_info.gaia.ToString();
  }

  return RespondNow(WithArguments(profile_user_info.ToValue()));
}
```

Three facts fall straight out of that, none of which are in the reference page:

- **The permission check is a silent branch.** No permission ⇒ the response is a
  default-constructed `ProfileUserInfo` — `{email: "", id: ""}` — with `ok`. **A missing
  permission and a signed-out profile are indistinguishable to the caller.** Any consumer must
  treat empty-string as "unknown", not as an error.
- **The identity is `Profile`-scoped.** `IdentityManagerFactory::GetForProfile(profile)` — one
  identity per *browser profile*. There is no tab, window, frame or origin parameter anywhere
  in the signature. This is the decisive point for #117; see §1.5.
- **`id` is the Gaia id**, an opaque numeric account identifier — not human-readable, so it is
  no use as a *label* even when populated. (It would be a fine *discriminator*; see §7.3.)

### 1.3 Two traps: the `SYNC` default, and incognito

The helper the above calls, same file, verbatim:

```cpp
CoreAccountInfo GetAccountInfoFromProfileDetails(
    const std::optional<api::identity::ProfileDetails>& details,
    const signin::IdentityManager* identity_manager,
    const syncer::SyncService* sync_service) {
  const api::identity::AccountStatus account_status =
      details ? details->account_status : api::identity::AccountStatus::kNone;
  const CoreAccountInfo primary_account_info =
      identity_manager->GetPrimaryAccountInfo(signin::ConsentLevel::kSignin);
  if (primary_account_info.IsEmpty()) {
    return CoreAccountInfo();
  }

  switch (account_status) {
    case api::identity::AccountStatus::kAny:
      return primary_account_info;
    case api::identity::AccountStatus::kNone:
    case api::identity::AccountStatus::kSync:
      return sync_service &&
                 sync_service->GetUserSettings()->GetSelectedTypes().Has(
                     syncer::UserSelectableType::kExtensions)
             ? primary_account_info
             : CoreAccountInfo();
  }

  NOTREACHED() << "Unexpected value for account_status: "
               << api::identity::ToString(account_status);
}
```

🔴 **The default is `SYNC`, and `SYNC` means "sync is on *and syncing extensions*".** The
[reference](https://developer.chrome.com/docs/extensions/reference/api/identity) confirms the
default:

> `ProfileDetails` — `accountStatus` … A status of the primary account signed into a profile
> whose `ProfileUserInfo` should be returned. **Defaults to `SYNC` account status.**

> `AccountStatus` — `"SYNC"` Specifies that Sync is enabled for the primary account.
> `"ANY"` Specifies the existence of a primary account, if any.

So a plain `getProfileUserInfo()` on a profile that is signed in to Google but **not syncing
extensions** returns `{email: "", id: ""}`. The correct call for "is there an account at all"
is `getProfileUserInfo({ accountStatus: "ANY" })` — Chrome 84+. Anyone reading only the
reference page would write the broken form and conclude the API is flaky.

Also note `GetPrimaryAccountInfo(signin::ConsentLevel::kSignin)`: this is the account signed
into the *browser*, at signed-in (not sync-consented) level. A profile with no browser
sign-in — very common for people who use Chrome profiles purely as containers and only sign
into Google *on the web* — returns empty regardless of `accountStatus`. **Signing into
`chat.google.com` does not sign you into Chrome**, and that is precisely the population this
feature serves.

🔴 **Incognito is an error, not an empty.** `IsOffTheRecord()` ⇒ `Error(kOffTheRecord)`, i.e.
a rejected promise / `chrome.runtime.lastError`. A consumer must catch, not just check for
empty strings.

### 1.4 It is not callable from a content script

From the [content-scripts concepts page](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
verbatim — this is the exhaustive allowlist:

> Content scripts can access the following extension APIs directly:
> `dom`, `i18n`, `storage`, `runtime.connect()`, `runtime.getManifest()`, `runtime.getURL()`,
> `runtime.id`, `runtime.onConnect`, `runtime.onMessage`, `runtime.sendMessage()`

> Content scripts are unable to access other APIs directly. But they can access them
> indirectly by exchanging messages with other parts of your extension.

`identity` is not on the list. So this route additionally requires a **round trip through the
service worker** — and `packages/extension/src/background.ts` is currently a log-only stub
(`CLAUDE.md`: *"the functional bridge lives in the content script … `src/background.ts` only
logs"*). Adding a request/response protocol to the service worker, in an extension whose
architecture deliberately keeps it inert, is real structural cost on top of the permission
cost.

### 1.5 Verdict: it answers the wrong question

The scenario #107 exists to serve, in its own words:

> **two Chat clients are legitimate and must be separately usable.** A Chrome work profile and
> a personal profile each running the Chat app, mapped to two different deck keys.

and, on why the id is opaque:

> a single profile signed into two accounts (`/u/0/`, `/u/1/`) yields **one install and two
> Chat windows**.

Cross-referencing §1.2: identity is `Profile`-scoped, and #107's install id is *also*
per-profile (`crypto.randomUUID()` into `chrome.storage.local`). So:

| Case | Does `getProfileUserInfo` discriminate? |
|---|---|
| Two Chrome **profiles**, one account each | Yes — **but so does the per-install id already**, and the label is only cosmetic |
| One Chrome profile, two accounts (`/u/0/`, `/u/1/`) | **No.** Both windows get the same email — two identical dropdown entries, the exact failure #117 exists to prevent |
| Profile not signed into Chrome (web-only login) | **No.** Empty (§1.3) |
| Profile signed into Chrome as A, Chat window signed into B | **Wrong.** Confidently reports A — worse than no label |

It is *right* only in the case that needs no help and *wrong or empty* in every case that
does, while adding the extension's first install-time warning. **Reject.** This settles the
sub-question #117 posed as "weigh whether that permission is worth it versus scraping": it is
not, and not by a narrow margin — the API is not merely expensive, it is **not a source of the
requested fact**.

---

## 2. The `/u/<n>/` account index

### 2.1 What the route grammar actually accepts (live probe)

`chat.google.com`'s login redirector preserves a recognised path in its `continue=` parameter
and discards an unrecognised one — the same free route oracle
[`chat-roster-dom.md` §2.1](chat-roster-dom.md) used. Reproduce:

```sh
for p in "u/0/" "u/1/" "u/9/" "u/99/" "u/-1/" "u/abc/" "u/0/room/AAAA" \
         "?authuser=1" "?authuser=user@example.com"; do
  printf '%-28s ' "$p"
  curl -sS -o /dev/null -D - -A "Mozilla/5.0 Chrome/140" "https://chat.google.com/$p" \
    2>/dev/null | grep -i '^location:' | head -1
done
```

Observed (2026-08-23, unauthenticated):

| Probe | Result |
|---|---|
| `/u/0/`, `/u/1/`, `/u/9/`, `/u/99/` | ✅ preserved → `continue=https://chat.google.com/u/<n>/` |
| `/u/0/room/AAAA` | ✅ preserved |
| `/u/-1/` | ❌ bounced to `https://chat.google.com/?hasBeenRedirected=true` |
| `/u/abc/` | ❌ bounced |
| `?authuser=1`, `?authuser=user@example.com` | query string preserved verbatim — see the caveat below |

**Conclusion: `<n>` is syntactically a non-negative integer and nothing else.** `u/99` is
accepted, so it is not validated against the number of signed-in accounts at the routing layer.
There is no form of this segment that carries an address or a domain.

⚠️ **The `authuser` rows prove nothing.** The redirector preserves the *entire* query string
whatever it contains, so "preserved" is not evidence that Chat honours `authuser`, let alone
that it honours an email-valued one. Do not cite this as a feature.

### 2.2 What Google documents about index ordering

From [Sign in to multiple accounts at once (Computer)](https://support.google.com/accounts/answer/1721977?hl=en&co=GENIE.Platform%3DDesktop),
verbatim:

> In many cases, your default account is the one you signed in with first.

> If you're signed in to multiple accounts at the same time, sometimes Google can't tell which
> account you're using. You might get results from your default account.

That is the whole of Google's public statement on ordering, and it is enough to settle the
stability question in the negative:

- The index is a property of **the sign-in session**, not of the account. Sign in to the
  personal account first tomorrow and today's `/u/1/` is tomorrow's `/u/0/`.
- Google hedges even this (*"in many cases"*), and explicitly documents that it *"can't tell
  which account you're using"* in the multi-account case — a remarkable admission to build a
  key on.
- Nothing on the page mentions URLs at all; the `/u/<n>/` convention is **undocumented
  product behaviour**, observable (§2.1) but not promised.

### 2.3 Can the index be mapped to an identity without scraping?

**No documented mechanism exists.** Searching Google's own developer and support corpora turns
up the index only *incidentally*, never as a specified interface:

- The Chat API's own deep-link guide hardcodes it:
  `https://mail.google.com/chat/u/0/#chat/space/1234567`
  ([Create a named space](https://developers.google.com/workspace/chat/create-spaces)) — index
  0 as a literal, with no explanation of what it means or how to compute it.
- `authuser=0` appears inside example redirect URIs in Google's OAuth documentation
  ([Streamlined linking](https://developers.google.com/identity/account-linking/oauth-with-sign-in-linking)),
  again as an incidental component of a returned URL, not a documented input.

The endpoints that *do* map an index to an account (`accounts.google.com/ListAccounts` and
friends) are **undocumented internal interfaces**, unversioned and cookie-authenticated. An
extension calling one to render a dropdown label is inventing a dependency on unpublished
Google infrastructure, and it would additionally need a host permission on
`accounts.google.com`. **Out of the question for a non-load-bearing string.**

### 2.4 Verdict: a fine label, an unacceptable key

- ✅ **Zero cost.** It is in `location.pathname`, which the content script already has.
- ✅ **It discriminates the hard case.** Two Chat windows in one profile differ exactly by this
  segment — the one case §1.5 showed `getProfileUserInfo` cannot handle.
- ❌ **Not stable across sessions** (§2.2), so it must never be folded into the binding key.

🔴 **Direct consequence for #107.** #107 kept the client id opaque *specifically* so an account
discriminator could be appended later — *"appending an account discriminator later is a value
change, not a schema change"*. **The account index is the wrong thing to append.** An id of
`<uuid>#u1` inherits the index's session-dependence, and every deck binding silently
re-targets the day the user signs in in a different order. If a discriminator is ever needed,
derive it from something account-intrinsic (a hash of the discovered address, or the Gaia id)
— never from the position.

---

## 3. Other extension-API routes, and what they cost

| Route | Permission cost | Does it yield a human-readable account label? |
|---|---|---|
| `identity.getProfileUserInfo` | `identity.email` — **install warning** *"Know your email address"* | Sometimes, and for the **wrong scope** (§1.5) |
| `identity.getAuthToken` + userinfo | `identity` + an `oauth2` client id in the manifest + **interactive user consent** | Yes, and it yields `hd` too (§4) — at the price of an OAuth consent screen to name a dropdown row |
| `identity.getAccounts` | `identity` | Would enumerate the profile's accounts — but **"only supported on dev channel"** ([reference](https://developer.chrome.com/docs/extensions/reference/api/identity)). Unusable |
| `chrome.cookies` | `"cookies"` **plus** host permissions — *"host permissions for any hosts whose cookies you want to access"*, and *"this method only retrieves cookies for domains that the extension has host permissions to"* ([reference](https://developer.chrome.com/docs/extensions/reference/api/cookies)) | **No.** See below |
| `chrome.instanceID` | `"gcm"` — *"Gives access to the `chrome.gcm` and `chrome.instanceID` APIs"* ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)) | **No.** *"Retrieves an identifier for the app instance"* — an install id, which #107 already mints for free with `crypto.randomUUID()` |
| `chrome.enterprise.*` | Force-install by policy only | **No** — device attributes, and ChromeOS-scoped |
| Any profile-name API | — | **Does not exist.** The [API index](https://developer.chrome.com/docs/extensions/reference/api) has no `chrome.profiles`/`browserProfile`; nothing exposes the Chrome profile's name or avatar to an extension |

**On `chrome.cookies` specifically — it is the worst trade in the table and should be named as
such.** To reach Google's session cookies you would declare `"cookies"` *and* a host permission
broad enough to cover them, i.e. `*://*.google.com/` — the manifest snippet in Chrome's own
[cookies reference](https://developer.chrome.com/docs/extensions/reference/api/cookies) uses
exactly that pattern. That is read access to the session cookies of **every Google property**,
requested to render the word "work". And it does not even work: Google's session cookies
(`SID`, `SAPISID`, `__Secure-*`) are opaque, undocumented, and carry no address — there is no
primary source describing their contents because Google publishes none, which is itself the
argument. Any implementation would be reverse-engineered and would break silently.
Fails the "least access" test of the
[permissions policy](https://developer.chrome.com/docs/webstore/program-policies/permissions)
and the necessity test of the
[limited-use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
(*"Extensions may only collect, use, or transmit user data that is necessary for the
extension's disclosed single purpose"*). **Reject outright.**

**Net: no extension API is a viable source for this label.** That is the central negative
finding of this note, and it is what makes §5 the answer by elimination rather than by
preference.

---

## 4. Workspace domain vs. email address

### 4.1 The domain is a real, documented identity claim

From [Google Identity — OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
verbatim, on the ID token payload:

> `hd` — The domain associated with the Google Workspace or Cloud organization of the user.
> **Provided only if the user belongs to a Google Cloud organization.**

> `email` — The user's email address. Provided only if you included the `email` scope in your
> request.

> `sub` — An identifier for the user, unique among all Google Accounts and never reused.

and as a request parameter:

> `hd` — Streamline the login process for accounts owned by a Google Cloud organization. By
> including the Google Cloud organization domain (for example, `mycollege.edu`), you can
> indicate that the account selection UI should be optimized for accounts at that domain.

with the warning:

> \[do not\] rely on this parameter for access control \[…\] validate the returned ID token's
> `hd` claim value, \[which\] is contained within a security token from Google, so the value
> can be trusted.

Three things follow.

1. **"Domain" is Google's own unit for "which organization is this".** It is not a folk
   concept; `hd` is a first-class claim. That is a genuine argument that *"acme.com"* is the
   right label — it matches the axis Google itself models, and it matches how #107 describes
   the distinction (*"work vs personal"*).
2. **It exists only for organization accounts.** A consumer account has no `hd` at all. So a
   domain-only label reduces two personal accounts to two identical `"gmail.com"` rows — the
   very failure mode #117 opens with. **Domain-first, but not domain-only.**
3. **The trustworthy path to `hd` is an ID token**, i.e. OAuth (§3). Not available for the
   price we are willing to pay.

### 4.2 So: derive the domain, don't fetch it

Since `hd` is unreachable cheaply, the practical form is: **discover an address (§5), then take
the part after `@` when it is not a consumer domain.** This is a heuristic, and it should be
labelled as one in the code:

- ✅ It matches `hd` for the overwhelmingly common Workspace case, where the primary domain is
  the address domain.
- ⚠️ It diverges where a Workspace has **domain aliases or secondary domains** — a user whose
  address is `@acme-eu.com` in an organization whose `hd` is `acme.com` gets `acme-eu.com`.
  For a label that is *fine*; for anything load-bearing it would not be.
- ⚠️ Consumer domains (`gmail.com`, `googlemail.com`) must be special-cased to fall through to
  the local part, or the label is useless.

### 4.3 The domain is also the better thing to put on a screen

This is a design argument, not a source claim, and it is the reason to prefer domain even where
both are available:

- The Property Inspector and the deck sit **in the frame during a screen share** — the exact
  context this whole product is used in. `acme.com` leaks an employer; `yann@acme.com` leaks a
  personal identifier and a spammable address.
- It is shorter, which matters on a 72×72 key if the label is ever rendered there.
- The
  [limited-use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
  requires data use be *"necessary for the extension's disclosed single purpose"*. Storing a
  domain rather than a full address is the narrower reading of "necessary" for a label, and it
  is trivially defensible in a store review.

**Verdict on the sub-question:** yes, the domain is the better label — *when the account has a
distinguishing one*. See the ladder in §7.

---

## 5. The recommended route: the page itself

### 5.1 Why this is the answer by elimination

§1–§3 exhaust the extension-API surface and find nothing usable at an acceptable price. What
remains is the DOM of a page the content script is **already injected into**:
`https://chat.google.com/*` is required for the roster
([`chat-roster-dom.md` §1.5](chat-roster-dom.md)), so reading the account label there is
**strictly zero incremental permission cost** and the strongest possible answer to the
"least access" test. It is also the only route that is *per-window*, which is the scope #117
actually asked for.

Two things are already known and save time:

- ❌ **`document.title` is not a source.** Observed live during #112 as
  `"Global Announcements - Chat"` with unread conversations present
  ([`chat-roster-dom.md` §7.4](chat-roster-dom.md)) — no account, no domain.
- ❌ **Page JavaScript state is not reachable.** Content scripts run in an isolated world
  ([content-scripts concepts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts):
  *"An isolated world is a private execution environment that isn't accessible to the page"*).
  Only the DOM is readable.

### 5.2 🔴 The structural risk to check first: the OneGoogle bar is cross-origin

Chat's CSP `frame-src` is the exhaustive list of origins that may appear as a child frame.
Reproduce:

```sh
curl -sS -o /dev/null -D - -A "Mozilla/5.0 Chrome/140" https://chat.google.com/ \
  | grep -o "frame-src[^;]*" | tr ' ' '\n' | grep -iE "ogs|accounts|myaccount"
```

Observed (2026-08-23):

```
https://accounts.google.com/
https://ogs.google.com/
https://myaccount.google.com/accounts/
https://myaccount.google.com/profile-picture
https://myaccount.google.com/profile-picture/
https://accounts.google.com/RotateCookiesPage
```

`ogs.google.com` is Google's **OneGoogle** service — the shared top-right avatar/account
surface, and its presence in `frame-src` means Chat is *permitted* to render the account
surface as a **cross-origin iframe**. If the signed-in address is rendered only inside that
frame, then:

- The Chat content script **cannot read it**, at any `all_frames` setting — `all_frames: true`
  evaluates `matches` against each frame's own URL
  ([manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts):
  *"Each frame is checked independently for URL requirements"*), and an `ogs.google.com` frame
  does not match `https://chat.google.com/*`.
- Reading it would need `https://ogs.google.com/*` in both `matches` and `host_permissions` —
  a permission on a **Google-wide account origin**, which is a materially worse ask than the
  Chat host permission and, for a label, is back in §3's rejected territory.

The plausible-but-unverified split is that the **collapsed avatar button** lives in the Chat
document while the **expanded menu** is the `ogs.google.com` frame. If so, everything hinges on
whether that button's accessible name carries the address. **That is precisely what §6.3
measures, and it is the single highest-value unknown in this note.**

🔴 **Do not skip to writing a selector.** No `aria-label`, class name or attribute for the
account button is asserted anywhere in this document, because none was observed. Google
regenerates class names per deploy ([`chat-roster-dom.md` §8](chat-roster-dom.md)); the only
acceptable handles are `aria-label`, `data-*`, `href`, and rendered text.

---

## 6. Investigation procedure

Runnable against a live authenticated Chat window. Ordered cheapest-first. Prerequisites for
the dev-bridge path are the three manifest edits in
[`chat-roster-dom.md` §5.3](chat-roster-dom.md) plus `just build-extension-debug`, with all
`meet.google.com` tabs closed (the bridge is single-client) and `just dev-bridge` running.
See [`docs/development.md`](../development.md).

### 6.0 🔴 The #113 discipline — apply it to every step below

`DebugControl` now reports both (`packages/protocol/src/debug.ts`):

```ts
/** Trimmed, truncated `textContent` — handy when there is no aria-label. */
text: string;
/** Trimmed, truncated `innerText`. Unlike `text`, this respects CSS:
 *  `display: none` content is excluded. */
visibleText: string;
fontWeight: string;
```

**`textContent` includes `display: none` text, so CSS-hidden markup looks identical to real
markup.** #113 is the cautionary tale: #112 declared the Chat `Unread` span meaningless
because `textContent` found it on all 16 rows, when it was rendered on only 3. **Every finding
in this investigation must be recorded as a `text` / `visibleText` pair**, and the difference
interpreted:

| `text` | `visibleText` | Reading |
|---|---|---|
| has address | has address | ✅ Rendered on screen — a real, live label source |
| has address | empty / no address | ⚠️ Present but **CSS-hidden** — usable for a label (the DOM value is still current), but it is *screen-reader or template markup*, so treat it as a lower-confidence tier and re-verify after any Google deploy |
| empty | — | Absent |

⚠️ **Read `visibleText` on the candidate element, not on an inner span.** `innerText` on an
element that is itself `display: none` falls back to `textContent`
([`chat-roster-dom.md` §8.1](chat-roster-dom.md)) — querying the inner node directly
reintroduces the exact bug.

⚠️ One devbridge caveat that matters here: **`/dump?q=` filters on `ariaLabel` and `text`, not
`visibleText`** (`packages/extension/src/plugins/debug-plugin.ts`, `collect()`). So a `dump`
filter will happily match hidden text — which is *useful* for discovery (it finds candidates
`innerText` would miss) but means the hit must then be re-read for its `visibleText` before you
believe it. Also remember `MAX_HTML = 300` truncates `outerHTML`.

### 6.1 Redact before pasting

Every step below prints your own email address. **Replace the local part and domain with
placeholders before pasting output into a GitHub issue.** Record the *shape*
(`<local>@<domain>`, which attribute carried it, whether `text` and `visibleText` agreed), not
the value.

### 6.2 Settle the URL shape (row 19) — 10 seconds, no tooling

In the Chat window's DevTools console (or `chrome://inspect/#pages` → *inspect*, if Chat runs
as an installed app window):

```js
console.log(JSON.stringify({
  href: location.href, pathname: location.pathname,
  search: location.search, hash: location.hash,
  lang: document.documentElement.lang, title: document.title,
}, null, 2));
```

**Record, for each of:**

| Case | Question |
|---|---|
| Only one account signed in | Is there a `/u/<n>/` segment at all, or a bare `/`? |
| Two accounts, default window | Is it `/u/0/`? |
| Two accounts, non-default window | Is it `/u/1/`? Does it **persist** as you navigate between conversations, or does the app strip it? |
| After a full reload of the non-default window | Still `/u/1/`? |

This decides whether ladder tier 4 (§7) is reachable at all. If the app strips the segment once
loaded, the index is not available to the content script and the ladder loses a rung.

Also capture `document.documentElement.lang` — §6.5 needs it, and
[`chat-roster-dom.md` §8.5](chat-roster-dom.md) already flagged locale as the standing risk for
every text-based signal in this codebase.

### 6.3 Hunt the identity in the Chat document (rows 17, 20)

Broad-to-narrow, through the dev bridge. **Nothing here presumes a selector**; each query is a
net.

```sh
# (a) Anything whose aria-label or textContent contains an "@" — the address shape.
curl -sG 'localhost:2397/dump' --data-urlencode 'q=@' | jq '.controls[] |
  {tag, ariaLabel, role, text, visibleText, href: .attrs.href, title: .attrs.title}'

# (b) The words Google uses around the account surface.
for term in "Google Account" "account" "Signed in" "Switch account" "Sign out"; do
  echo "== $term"
  curl -sG 'localhost:2397/dump' --data-urlencode "q=$term" | jq '.count'
done

# (c) Any link to the account infrastructure — an href is the most durable handle there is.
curl -sG 'localhost:2397/query' \
  --data-urlencode 'selector=a[href*="accounts.google.com"], a[href*="myaccount.google.com"], a[href*="SignOutOptions"], a[href*="authuser"]' \
  | jq '.count, (.controls[] | {ariaLabel, text, visibleText, href: .attrs.href})'

# (d) The avatar image — its alt/aria-label is a classic carrier, and its src origin
#     tells you whether the account surface is local or framed.
curl -sG 'localhost:2397/query' \
  --data-urlencode 'selector=img[src*="googleusercontent.com"], img[src*="profile-picture"]' \
  | jq '.controls[] | {alt: .attrs.alt, ariaLabel, src: .attrs.src}'

# (e) Iframes — is the account surface in-document or cross-origin? (settles row 18)
curl -sG 'localhost:2397/query' --data-urlencode 'selector=iframe' \
  | jq '.controls[] | {src: .attrs.src, name: .attrs.name, id: .attrs.id, html}'
```

**For every hit, record all of:** `tag`, `role`, `ariaLabel`, `text`, `visibleText`, the full
attribute map (looking for `data-*`, `title`, `href`, `alt`), and — per §6.0 — whether `text`
and `visibleText` **agree**.

**Then rank the candidates by durability, best first:**

1. An `href` containing the address or a domain (e.g. an `Email=` or `hd=` query parameter).
   Machine-readable, and query-parameter names are far more stable than markup.
2. An `aria-label` / `title` / `alt` containing the address. Semantic, but **localised** —
   an English-only substring rule will fail elsewhere; extract with `/[^\s@]+@[^\s@]+/`, never
   by splitting on English words.
3. A `data-*` attribute carrying it.
4. Rendered text (`visibleText`) alone. Weakest — position-dependent and locale-dependent.

**Anything found only via `text` and not `visibleText` is CSS-hidden markup**; note it, use it
if nothing better exists, but flag it in the report (§6.6).

### 6.4 If §6.3 comes up empty: is it behind the menu, and is the menu cross-origin? (row 18)

```sh
# Snapshot the iframe set BEFORE opening anything.
curl -sG 'localhost:2397/query' --data-urlencode 'selector=iframe' | jq '.count'

# Open the account surface. Use a handle found in 6.3(b)/(d) — DO NOT guess a class.
# Example shape only; substitute the real selector you observed:
curl -sG 'localhost:2397/click' --data-urlencode 'selector=<the-handle-you-found>'

# Re-run every probe in 6.3, then re-count iframes.
curl -sG 'localhost:2397/query' --data-urlencode 'selector=iframe' \
  | jq '.controls[] | {src: .attrs.src}'
```

**Decision rule:**

| Observation | Consequence |
|---|---|
| Address appears in the Chat document only **after** the click | ❌ Unusable. A label must not require synthetically opening the user's account menu at `document_idle` — visible, disruptive, and racy |
| iframe count grows and the new frame's `src` is `ogs.google.com` (or the address never appears in the Chat document) | ❌ Confirms row 18. The identity is cross-origin; the label would cost `https://ogs.google.com/*`. **Do not pay it** — fall to §7 tier 4 |
| Address is in the Chat document at `document_idle`, no click needed | ✅ Ship it. This is the recommended source |

### 6.5 Timing

If §6.4 lands on ✅, confirm it is there when the content script actually looks. In the console
on a **fresh load**:

```js
// Substitute the handle found in 6.3. Poll, do not sample once.
const t0 = performance.now();
const id = setInterval(() => {
  const el = document.querySelector(/* the handle */);
  if (el) { console.log("found after", Math.round(performance.now() - t0), "ms",
                        {text: el.textContent, visible: el.innerText}); clearInterval(id); }
}, 100);
setTimeout(() => clearInterval(id), 30000);
```

**Record the delay.** `run_at: "document_idle"` does not mean "the SPA has rendered". If the
node appears late, the client must observe for it (Chat re-renders and can swap subtrees — the
same hazard `CLAUDE.md` documents for Meet's hand state) rather than read once and give up.
Because the label is non-load-bearing, the correct shape is: **emit the handshake immediately
with the best tier available, and upgrade the label later if discovery succeeds.** Never block
the handshake on it.

### 6.6 Reporting template

Paste into #117 (values redacted per §6.1):

```
(0) Environment
    accounts signed in: N     document.documentElement.lang: <...>

(1) URL shape
    single-account window pathname:  <...>
    /u/0/ window pathname:           <...>
    /u/1/ window pathname:           <...>
    survives navigation:  yes/no     survives reload:  yes/no

(2) Identity in the chat.google.com document at document_idle
    found:            yes/no
    carrier:          href-param | aria-label | title | alt | data-* | rendered-text
    handle:           <the semantic selector, NOT a class name>
    text:             <redacted shape, e.g. "<local>@<domain>">
    visibleText:      <redacted shape, or EMPTY>
    text == visibleText:  yes/no      <-- if no, it is CSS-hidden markup
    appears after:    <ms from load>

(3) Account menu
    click needed:     yes/no
    iframe count before/after:  N / M
    new frame origins:          <...>
    CROSS-ORIGIN (ogs.google.com):  yes/no   <-- if yes, route is dead at acceptable cost

(4) Domain
    address domain == expected Workspace domain:  yes/no
    consumer account seen (gmail.com):            yes/no

(5) Ladder tier actually reached, per window:  1 | 2 | 3 | 4 | 5
```

---

## 7. The fallback ladder (recommendation)

**This section is a recommendation, not a source claim.** It follows from #107's constraint
that the label is *"non-load-bearing, so a scraping failure degrades to a bad name rather than
a broken binding"*.

### 7.1 The ladder

First rung that yields a non-empty string wins.

| Tier | Label | Source | Example |
|---|---|---|---|
| **1** | The user's own label | `chrome.storage.local`, once set by hand — **never overwritten by discovery** | `work` |
| **2** | Last-known-good | The previously discovered label, cached | `acme.com` |
| **3** | **Domain** | `@`-suffix of a discovered address (§6.3), when not a consumer domain | `acme.com` |
| **4** | **Local part** | `@`-prefix, when the domain is `gmail.com`/`googlemail.com` | `yann` |
| **5** | **Account index** | `/u/<n>/` from `location.pathname` (§6.2), when present | `Chat u/1` |
| **6** | **Id stub** | `Chat · ` + first 4 hex chars of the #107 install id | `Chat · 4f2a` |

### 7.2 Why each rung, and what is rejected

- **Tier 1 above everything.** Auto-discovery filling in over a manual edit is the single most
  annoying possible bug here: the user renames the row to `work`, Google ships a deploy, and
  the rename evaporates. Discovery writes only into an *unset* label.
- **Tier 2 exists because discovery is flaky by construction.** Everything in tier 3–4 depends
  on Google markup, which drifts (`chat-roster-dom.md` §8 is a whole section about exactly
  this) and is locale-sensitive (§8.5 there). Caching means one bad deploy degrades the label
  *for new installs only*, instead of regressing every existing user's dropdown to `Chat · 4f2a`
  overnight. Cheap, and it converts a cliff into a ratchet.
- **Tier 3 before tier 4** for the §4.3 reasons: shorter, less sensitive on a shared screen,
  and it matches Google's own `hd` axis.
- **Tier 4 is the consumer-account escape.** Without it, two personal accounts both render
  `gmail.com` and the dropdown is exactly as unusable as two UUIDs. Special-case the consumer
  domains explicitly; do not try to be clever about "is this a Workspace domain" beyond that.
- **Tier 5 is the index — as a *label*, which is legitimate** (§2.4). It is the last rung that
  actually *discriminates two windows in one profile*, which is the case #117 exists for, so it
  is worth having even though it is ugly. Render it as `Chat u/1`, not bare `1`: the `u/`
  prefix is a hint that this is Google's account index, which a user can recognise from their
  own address bar and correct by hand (tier 1).
- **Tier 6 is deliberately not a counter.**

🔴 **`"Chat 1"` / `"Chat 2"` is rejected.** An ordinal assigned over connections is precisely
the scheme #107 already rejected for binding:

> Auto-assign-by-slot was rejected: connection order depends on which window opened first, so
> work and personal keys would silently swap.

The same objection applies to the *label*, and is arguably worse there — a wrong binding fails
visibly, whereas a label that has silently swapped means the user presses the key labelled
"Chat 1" believing it is work, and it is not. A **stable-per-install** suffix (`4f2a`) is ugly
but never lies, and it makes the two rows in the dropdown *distinguishable* even if not
*meaningful*, which is enough for the user to bind by trial and rename (tier 1).

### 7.3 Two consequences to carry into #110/#111

- **The label is per-window; the id is per-install.** Two Chat windows in one Chrome profile
  reach tier 6 with the **same** string, so the dropdown shows two identical rows. Tier 5
  rescues this *only if* §6.2 shows the `/u/<n>/` segment survives. **If it does not, #107's
  "two accounts in one profile" case has no automatic label at all** and depends entirely on
  tier 1. Flag this to #110 — it may justify making the label field prominent in the Options
  page rather than a hidden nicety.
- **Do not promote any of tiers 3–6 into the id.** §2.4 covers the index; the same applies to
  the domain and local part, which change when a user's address changes. If a per-account
  discriminator is ever needed in the id, hash something account-intrinsic and keep it opaque,
  exactly as #107 specified.

---

## 8. What this note does not answer — needs a live session

Ordered by how much the answer changes the design.

1. **Is the signed-in address or domain in the `chat.google.com` document at all, at
   `document_idle`?** (§6.3) If no, the entire recommended route collapses and the ladder
   starts at tier 5. **Highest impact by a wide margin.**
2. **Is the account surface a cross-origin `ogs.google.com` frame?** (§6.4) §5.2 proves it is
   *permitted* to be. If it is, the label is unreachable at acceptable permission cost and (1)
   is answered "no" by construction.
3. **Does `/u/<n>/` persist in `location.pathname` of a running Chat window?** (§6.2) Decides
   whether the ladder has a tier 5 — i.e. whether the two-accounts-one-profile case has *any*
   automatic label.
4. **Which attribute carries it, and does `text` agree with `visibleText`?** (§6.0, §6.3)
   Determines whether the extractor is a durable `href` parse or a fragile text scrape, and
   whether we are reading rendered UI or screen-reader-only markup.
5. **How long after load does it appear?** (§6.5) Decides read-once vs. observe-and-upgrade.
   The handshake must not block on it either way.
6. **Does the address domain match the Workspace `hd`?** (§4.2) Only matters for
   multi-domain organizations; a label-level wrinkle, not a blocker.
7. **Locale.** Every text-based handle in this repo's Chat work is an English string
   ([`chat-roster-dom.md` §8.5](chat-roster-dom.md)). If the label ends up depending on an
   English `aria-label` substring, it inherits that risk and belongs in the same per-surface
   selector config #108 established. Extracting with an `@`-shaped regex instead of an English
   word avoids it — prefer that.

---

## 9. Live confirmation (#117) — the route works, in the top frame

**Observed, not inferred.** Captured 2026-08-23 against a signed-in `chat.google.com`
tab through the dev bridge (`/query`, `/dump` on :2397), with a debug-only content script
at `all_frames: false` — so **everything below is the top frame**. All addresses are
redacted here; the raw values were never written to disk.

### 9.1 The account identity is in the top frame

§5.2 flagged the risk that the identity might live only in the cross-origin OneGoogle
frame, killing the DOM route. **It does not.** The top-frame document contains:

```html
<a class="gb_C gb_9a gb_8" role="button"
   aria-label="Google Account: <Display Name>  &#10;(<local>@<domain>)">
```

- Exactly **one** such element in the document.
- **`text` and `visibleText` are both empty.** The identity exists *only* in the
  attribute — there is no text-node route, and the #113 `innerText` technique does not
  apply here. (Checked explicitly rather than assumed.)
- No `href`. `role="button"` — it opens the account switcher.
- Both the **display name** and the **address** are present, so the domain is derivable
  by taking the part after `@`.

The `ogs.google.com` frame *is* present (§5.2's fear was well-founded in principle), but
the identity is duplicated into the host page's OneGoogle bar markup, so no cross-origin
reach is needed.

### 9.2 🟢 A locale-independent selector

The obvious handle is the `"Google Account:"` prefix — and it is **English**, so it
carries exactly the locale risk that `chat-roster-dom.md` §8.5 documents for the unread
tokens. It is avoidable here:

| Selector | Matches |
|---|---|
| `[aria-label*="@"]` | **1** |
| `a[role="button"][aria-label*="@"]` | **1** |

**Selecting on `@` rather than on a localised word makes this locale-invariant** — an
email address contains `@` in every locale. Prefer
`a[role="button"][aria-label*="@"]`: same single match, but scoped enough that an
unrelated mention chip acquiring an `@`-bearing `aria-label` would not collide.

This is a **better position than the roster signals are in** (§8.5 of the roster note),
which have no locale-free formulation and must stay overridable.

Extracting the address from the label is a **lexical token extraction**, not parsing —
take the `@`-bearing token. That is the same justification `packages/extension/src/meet/location.ts`
already gives for its `MEETING_CODE` pattern ("a fixed lexical token, so a single anchored
pattern is the right tool — not a parser").

The `gb_*` classes are Google-Bar-namespaced and still generated; **do not use them**.

### 9.3 The account index is readable without touching the frame

The OneGoogle iframe's `src` is visible from the top frame and carries the index:

```
https://ogs.google.com/u/0/widget/app?awwd=1&gpa=4&...
```

So `/u/<n>` is obtainable **without** cross-origin access — useful for fallback tier 5.
It remains session-dependent (§3), so it must not become part of the client id (§9.5).

Other frames seen, none needed: `studio.workspace.google.com` (side panel),
`contacts.google.com` (hovercards), `accounts.google.com/RotateCookiesPage`.

### 9.4 Consequences for the recommendation

§5's route is **confirmed and cheap**: zero incremental permission, top frame, one
element, locale-invariant selector, both name and domain available. The fallback ladder
in §7 stands unchanged, but tiers 3–6 are now genuinely unlikely to be reached.

### 9.5 ⚠️ Still untested

- **Timing.** The element was present when queried a few seconds after load. Whether it
  exists at `document_idle` — or needs an observer like the Meet controls do — was not
  measured. Assume it may arrive late.
- **A second account.** Only one signed-in account was available, so the claim that the
  label distinguishes two accounts in one profile is *structurally* sound but
  unobserved.
- **Uniqueness at scale.** `[aria-label*="@"]` matched once in this session. A different
  Chat state (an open mention autocomplete, say) could plausibly introduce another.
  The scoped selector mitigates but does not disprove this.

## Sources

- [Chrome for Developers — `chrome.identity` API reference](https://developer.chrome.com/docs/extensions/reference/api/identity) — `getProfileUserInfo`, `ProfileUserInfo.email`/`.id`, `ProfileDetails.accountStatus` (default `SYNC`), `AccountStatus` enum, `getAuthToken`, `getAccounts` ("only supported on dev channel")
- [Chrome for Developers — Declare permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list) — `identity`, `identity.email` ("Warning displayed: _Know your email address._"), `cookies`, `gcm`, `storage`
- [Chrome for Developers — Content scripts (concepts)](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) — the exhaustive list of APIs content scripts may call directly; isolated worlds
- [Chrome for Developers — `content_scripts` manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts) — per-frame `matches` evaluation under `all_frames`
- [Chrome for Developers — `chrome.cookies` API reference](https://developer.chrome.com/docs/extensions/reference/api/cookies) — `"cookies"` **plus** host permissions; `getAll` limited to permitted domains
- [Chrome for Developers — `chrome.instanceID` API reference](https://developer.chrome.com/docs/extensions/reference/api/instanceID) — "Retrieves an identifier for the app instance"; `gcm` permission
- [Chrome for Developers — Extension APIs index](https://developer.chrome.com/docs/extensions/reference/api) — the full namespace list; **no** profile-name API
- [Chrome for Developers — OAuth 2.0 tutorial](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth) — the `oauth2` manifest section and `identity` permission required for `getAuthToken`
- [Chrome Web Store — Program policies: Use of permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions) — "narrowest permissions necessary"; "least access to data or functionality"; no future-proofing
- [Chrome Web Store — Program policies: Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) — data must be "necessary for the extension's disclosed single purpose"
- **Chromium source** — [`chrome/browser/extensions/api/identity/identity_get_profile_user_info_function.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/identity/identity_get_profile_user_info_function.cc) — `IdentityGetProfileUserInfoFunction::Run()` and `GetAccountInfoFromProfileDetails()`: the `kIdentityEmail` check, `ConsentLevel::kSignin`, the `kSync` ⇒ extensions-sync requirement, and the off-the-record error
- [Google Identity — OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) — the `hd`, `email`, `email_verified` and `sub` ID-token claims; `hd` as an authentication-URI parameter and the warning not to trust it outside a token
- [Google Account Help — Sign in to multiple accounts at once (Computer)](https://support.google.com/accounts/answer/1721977?hl=en&co=GENIE.Platform%3DDesktop) — "In many cases, your default account is the one you signed in with first"; "sometimes Google can't tell which account you're using"
- [Google Chat guide — Create a named space](https://developers.google.com/workspace/chat/create-spaces) — `https://mail.google.com/chat/u/0/#chat/space/1234567`, the index appearing only as an undocumented literal
- [Google Account Linking — Streamlined linking with OAuth](https://developers.google.com/identity/account-linking/oauth-with-sign-in-linking) — `authuser=0` and `hd=example.com` appearing incidentally in a returned redirect URI
- **Live unauthenticated HTTP probes** of `https://chat.google.com/*` (2026-08-23) — the `/u/<n>/` route oracle (§2.1) and the CSP `frame-src` account origins (§5.2). Commands to reproduce are inline.
- Repo source and prior research, read directly: [`docs/research/chat-roster-dom.md`](chat-roster-dom.md) (§5.3 bridge setup, §7.4 `document.title`, §8 `innerText` discipline, §8.5 locale risk), `packages/protocol/src/debug.ts` (`DebugControl.text` / `.visibleText` / `.fontWeight`), `packages/extension/src/plugins/debug-plugin.ts` (`collect()` filters on `ariaLabel` + `text`, not `visibleText`; `MAX_HTML = 300`), `packages/devbridge/src/http-server.ts` (route list), `packages/extension/manifest.config.ts` (current permissions: `storage` only), and issues [#107](https://github.com/sigma/callctl/issues/107) / [#113](https://github.com/sigma/callctl/issues/113)
