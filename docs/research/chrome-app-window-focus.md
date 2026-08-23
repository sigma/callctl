# Focusing an installed Chrome app window from the plugin (macOS)

> Research asset for [Map: Google Chat unread](https://github.com/sigma/callctl/issues/104),
> ticket [#106](https://github.com/sigma/callctl/issues/106).
> Primary sources: **Chromium source at `main`**
> ([chrome/common/chrome_switches.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/chrome_switches.cc),
> [chrome/browser/ui/web_applications/navigation_capturing_process.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/web_applications/navigation_capturing_process.cc),
> [chrome/browser/ui/startup/startup_browser_creator.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_browser_creator.cc),
> [.../startup_browser_creator_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_browser_creator_impl.cc),
> [.../web_app_startup_utils.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/web_app_startup_utils.cc),
> [chrome/browser/ui/web_applications/web_app_launch_process.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/web_applications/web_app_launch_process.cc),
> [chrome/browser/apps/app_shim/app_shim_manager_mac.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/apps/app_shim/app_shim_manager_mac.cc),
> [chrome/app_shim/app_shim_delegate.mm](https://chromium.googlesource.com/chromium/src/+/main/chrome/app_shim/app_shim_delegate.mm),
> [chrome/app_shim/app_shim_controller.mm](https://chromium.googlesource.com/chromium/src/+/main/chrome/app_shim/app_shim_controller.mm),
> [chrome/browser/web_applications/os_integration/mac/web_app_shortcut_mac.mm](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/web_applications/os_integration/mac/web_app_shortcut_mac.mm),
> [.../mac/apps_folder_support.mm](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/web_applications/os_integration/mac/apps_folder_support.mm),
> [components/crx_file/id_util.cc](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc);
> **Apple `open(1)`** (`man 1 open`, macOS 26.5.2 / build 25F84);
> **Google Chat's own web app manifest** (`https://chat.google.com/manifest.json`);
> plus an **empirical probe of this machine's installed Chat shim** (`~/Applications/Chrome
> Apps.localized/Google Chat.app`, Chrome 151).

## TL;DR

1. **A plain `chrome <url>` launch does NOT focus the app window — it opens a tab.**
   Command-line URLs are navigated with `ui::PAGE_TRANSITION_AUTO_TOPLEVEL`
   ([startup_browser_creator_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_browser_creator_impl.cc)),
   and Chrome's navigation-capturing gate explicitly returns `false` for that transition
   ([navigation_capturing_process.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/web_applications/navigation_capturing_process.cc)).
   The M139 "links open your PWA" rollout does not rescue us. See [§1](#1-a-plain-url-launch-opens-a-tab).
2. **`--app-id=<app id>` DOES focus it, and for Chat specifically it is a *focus*, not a
   new window** — Chat's manifest ships `"launch_handler":{"client_mode":"focus-existing"}`,
   and `WebAppLaunchProcess` honours that by finding the existing app browser and
   activating it. See [§2](#2---app-id-is-the-switch-that-targets-an-installed-app) and
   [§3](#3-what-focus-existing-buys-us).
3. **`--app=<url>` is the wrong switch.** It opens a fresh "shortcut app" window every
   time and never consults the installed-app registry. See [§2](#2---app-id-is-the-switch-that-targets-an-installed-app).
4. **`open -b com.google.Chrome.app.<app id>` also works, and is the cheapest option
   on macOS** — Chrome writes a real `.app` shim per installed app under
   `~/Applications/Chrome Apps.localized/`, that shim is a live LaunchServices process
   while the window is open (verified on this machine, pid 18343), and `open` *without*
   `-n` reactivates a running app, which the shim turns into `ReopenApp()` →
   `AppShimManager::OnShimReopen` → show existing windows. See [§4](#4-the-macos-app-shim-route).
5. **The repo's current `open -n -a "Google Chrome" --args …` shape is the one thing that
   must change**: `-n` is documented to "Open a new instance of the application(s) even if
   one is already running" (`man 1 open`), which is exactly wrong for a raise-the-window
   press. See [§5](#5-what-this-means-for-profile-openits).
6. **Do not compute the app id — discover it.** The a–p hash derivation is documented and
   reproducible in principle, but hashing Chat's *currently served* manifest id does **not**
   reproduce the id installed on this machine. The shim's `Info.plist` carries it verbatim
   (`CrAppModeShortcutID`). See [§6](#6-getting-the-app-id).
7. **Profile targeting is the sharp edge of the shim route.** `--app-id` composes with
   `--profile-directory`; `open -b <shim>` does not take a profile and resolves it from
   the shim's own registry. See [§7](#7-profiles).
8. **None of this threatens the map's fallback decision** — it only changes what the
   fallback *executes*. See [§9](#9-impact-on-104).

---

## 1. A plain URL launch opens a tab

Two facts compose into the answer.

**(a) Command-line URLs are AUTO_TOPLEVEL.**
[`startup_browser_creator_impl.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_browser_creator_impl.cc)
builds each startup tab as:

```cpp
NavigateParams params(browser, tab.url, ui::PAGE_TRANSITION_AUTO_TOPLEVEL);
```

**(b) Navigation capturing rejects AUTO_TOPLEVEL.** From
[`navigation_capturing_process.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/web_applications/navigation_capturing_process.cc)
(`IsPageTransitionValidForNavigationCapturing`, ~lines 108–129):

```cpp
bool IsPageTransitionValidForNavigationCapturing(ui::PageTransition transition) {
  switch (ui::PageTransitionStripQualifier(transition)) {
    case ui::PAGE_TRANSITION_TYPED:
    case ui::PAGE_TRANSITION_AUTO_TOPLEVEL:
    case ui::PAGE_TRANSITION_AUTO_BOOKMARK:
    ...
      return false;
    case ui::PAGE_TRANSITION_LINK:
    case ui::PAGE_TRANSITION_FORM_SUBMIT:
      break;
```

So capture is for **link clicks and form submits**, not for anything the browser was told
to open. The same file gates the whole mechanism on
`base::FeatureList::IsEnabled(features::kPwaNavigationCapturing)` and additionally
disables capture for "navigations from newly-created empty browsers" — which is precisely
the shape of a cold `open -n -a "Google Chrome" … <url>` launch.

**(c) The startup path has no URL→app lookup.**
[`web_app_startup_utils.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/web_app_startup_utils.cc)'s
`MaybeHandleWebAppLaunch` begins:

```cpp
std::string app_id = command_line.GetSwitchValueASCII(switches::kAppId);
if (app_id.empty()) {
  return false;
}
```

No `--app-id`, no web-app handling: the URL falls through to ordinary tab startup. There
is no "is this URL in an installed app's scope?" check anywhere on the command-line path.

**Conclusion (high confidence, from source):** launching `https://chat.google.com` via
the current `profile-open.ts` argv opens **a stray tab in a browser window**, beside the
already-open Chat app window. This is the failure mode #106 suspected.

The user-visible M139 rollout — ["available from Chrome 139 for Windows, Mac, and
Linux"](https://developer.chrome.com/docs/capabilities/pwa-navigation-management), see
also the [blink-dev PSA](https://groups.google.com/a/chromium.org/g/blink-dev/c/xl1hGAfxlA0)
(M134 for apps declaring `launch_handler`, M135 for all installed PWAs) — is about *web
links*, i.e. `PAGE_TRANSITION_LINK`. It does not extend to the CLI.

## 2. `--app-id` is the switch that targets an installed app

From [`chrome_switches.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/chrome_switches.cc),
verbatim:

```cpp
// Specifies that the associated value should be launched in "application" mode.
const char kApp[] = "app";

// Specifies that the extension-app with the specified id should be launched
// according to its configuration.
const char kAppId[] = "app-id";

// Overrides the launch url of an app with the specified url. This is used along
// with kAppId to launch a given app with the url corresponding to an item in
// the app's shortcuts menu.
const char kAppLaunchUrlForShortcutsMenuItem[] =
    "app-launch-url-for-shortcuts-menu-item";
```

Three readings:

- **`--app-id` is a shipping, cross-platform switch, not a dev-channel flag.** It lives in
  `chrome/common/chrome_switches.cc` (not in a `*_features.cc` behind a `base::Feature`),
  and Chrome itself writes it into the shortcuts it generates: `shell_integration.cc`'s
  `CommandLineArgsForLauncher` does
  `new_cmd_line.AppendSwitchASCII(switches::kAppId, extension_app_id);`, with the profile
  appended separately by `AppendProfileArgs` →
  `command_line->AppendSwitchPath(switches::kProfileDirectory, profile_path.BaseName());`
  ([shell_integration.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/shell_integration.cc)).
  *Inference:* a switch Chrome bakes into its own Windows/Linux shortcuts is not going to
  be removed from stable.
- **`--app=<url>` is a different thing.** In
  [`startup_browser_creator.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_browser_creator.cc),
  `MaybeLaunchAppShortcutWindow` validates the URL's scheme (`IsWebSafeScheme()` or
  `file:`) and calls `apps::OpenExtensionAppShortcutWindow(profile, url)` — a **new**
  window each time, with **no** lookup against installed web apps. Same source file shows
  the `kAppId` branch delegating, on non-ChromeOS, to `web_app::startup::MaybeHandleWebAppLaunch`.
- **`--app-launch-url-for-shortcuts-menu-item` is a modifier, not an alternative.** By its
  own comment it is "used along with kAppId". Irrelevant here: the map settled that a
  press *raises the window only*, no navigation to a conversation.

**Launching against a Chrome that is already running works.** `--app-id` does not require
a cold start: a second Chrome process forwards its command line through the process
singleton, and `StartupBrowserCreator::ProcessCommandLineAlreadyRunning` routes it to
`ProcessCommandLineWithProfile` — the same handler, including the `kAppId` branch
([startup_browser_creator.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_browser_creator.cc)).
That is also why the repo's existing `open -n -a` shape works today at all.

## 3. What `focus-existing` buys us

`--app-id` gets us to `WebAppLaunchProcess`
([web_app_launch_process.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/web_applications/web_app_launch_process.cc)),
which resolves the manifest's `launch_handler`:

```cpp
return web_app_->launch_handler().value_or(LaunchHandler());
```

and then:

```cpp
if (launch_handler.parsed_client_mode() == LaunchHandler::ClientMode::kAuto) {
  return LaunchHandler::ClientMode::kNavigateNew;
}
```

So the **default for an app with no `launch_handler` is `kNavigateNew`** — a new app
window per launch, which would be almost as bad as the stray tab. `MaybeFindBrowserForLaunch`
returns `nullptr` under `kNavigateNew` for a standalone app, forcing window creation;
otherwise it locates an existing window via `AppBrowserController::FindForWebApp()` and
the launch **activates and shows** it.

**Google Chat opts in.** Fetched live from `https://chat.google.com/manifest.json`:

```json
{"name":"Google Chat","short_name":"Chat","display":"standalone",
 "start_url":"/","id":"https://chat.google.com/","scope":"/",
 "scope_extensions":[{"type":"origin","origin":"https://mail.google.com/chat"}],
 "launch_handler":{"client_mode":"focus-existing"}, …}
```

`focus-existing` is exactly the semantic the map's press behaviour wants —
["Activates an already-running PWA window"](https://developer.chrome.com/docs/capabilities/pwa-navigation-management),
no navigation. **This is a property of Chat's manifest, not of Chrome**, so it can change
under us; the fallback should not *depend* on it for correctness, only for polish (worst
case with `kNavigateNew` you get a second app window, still an app window, still focused).

## 4. The macOS app-shim route

### Where the bundle lives, and what it is called

[`apps_folder_support.mm`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/web_applications/os_integration/mac/apps_folder_support.mm)
derives the folder as `GetWritableApplicationsDirectory()` (i.e.
`base::apple::GetUserDirectory(NSApplicationDirectory, …)`, `~/Applications`) plus
`GetLocalizableAppShortcutsSubdirName()`, which is channel-branded:
`"Chromium Apps.localized"` / `"Chrome Apps.localized"` / `"Chrome Canary Apps.localized"`.

The bundle identifier comes from `GetBundleIdentifierForShim` in
[`web_app_shortcut_mac.mm`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/web_applications/os_integration/mac/web_app_shortcut_mac.mm):

```cpp
if (!profile_path.empty()) {
  return base::StrCat({base::apple::BaseBundleID(), ".app.", normalized_profile_path, "-", app_id});
}
return base::StrCat({base::apple::BaseBundleID(), ".app.", app_id});
```

`web_app_shortcut_creator.mm` picks between the two forms with
`IsMultiProfile() ? base::FilePath() : info_->profile_path`.

**Verified empirically on this machine** (`/usr/libexec/PlistBuddy -c Print
"~/Applications/Chrome Apps.localized/Google Chat.app/Contents/Info.plist"`):

```
CFBundleIdentifier   = com.google.Chrome.app.pommaclcbfghclhalboakcipcmmndhcj
CrBundleIdentifier   = com.google.Chrome
CrAppModeShortcutID  = pommaclcbfghclhalboakcipcmmndhcj
CrAppModeShortcutURL = https://chat.google.com/
CrAppModeShortcutName = Google Chat
CFBundleExecutable   = app_mode_loader
CrBundleVersion      = 151.0.7922.72
```

No profile component ⇒ this is a **multi-profile shim** (see [§7](#7-profiles)).

### Why `open` focuses rather than duplicates

`man 1 open` (macOS 26.5.2):

> The **open** command opens a file (or a directory or URL), just as if you had
> double-clicked the file's icon. If no application name is specified, the default
> application as determined via LaunchServices is used […]
>
> **-b** *bundle_identifier* — Specifies the bundle identifier for the application to use
> when opening the file
>
> **-n** — Open a new instance of the application(s) even if one is already running.
>
> **-g** — Do not bring the application to the foreground.

The existence of `-n` as an opt-in is the documented statement that the default is to
**reuse and activate** the running instance; `-g` is the opt-out from foregrounding, so
plain `open -b …` foregrounds.

The shim is a *real, running LaunchServices app* while the window is open — verified with
`pgrep -fl app_mode_loader` on this machine while the Chat window was open:

```
18343 …/Chrome Apps.localized/Google Chat.app/Contents/MacOS/app_mode_loader
      --launched-by-chrome-process-id=18301 --launched-by-chrome-bundle-path=/Applications/Google Chrome.app …
```

Reactivating it lands in
[`app_shim_delegate.mm`](https://chromium.googlesource.com/chromium/src/+/main/chrome/app_shim/app_shim_delegate.mm),
whose `applicationShouldHandleReopen:hasVisibleWindows:` calls
`_appShimController->host()->ReopenApp()`. That crosses mojo to
[`app_shim_manager_mac.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/apps/app_shim/app_shim_manager_mac.cc)'s
`OnShimReopen`, which calls `LoadAndLaunchApp()`; `LoadAndLaunchApp_LaunchIfAppropriate()`
first tries `delegate_->ShowAppWindows()` and then walks browsers by activation order
(`ForEachCurrentBrowserWindowInterfaceOrderedByActivation`) calling
`browser->GetWindow()->Show()` on a match — **existing window shown, no duplicate**.

If Chrome is not running at all, the shim handles that too: per
[`app_shim_controller.mm`](https://chromium.googlesource.com/chromium/src/+/main/chrome/app_shim/app_shim_controller.mm)
it queries the singleton lock and connects to the running Chrome, "Otherwise, launch a new
Chrome process." So one command covers both the cold and warm case.

## 5. What this means for `profile-open.ts`

Today, [`packages/plugin/src/open/profile-open.ts:85`](../../packages/plugin/src/open/profile-open.ts)
builds:

```ts
return { file: "open", args: ["-n", "-a", app, "--args", profileFlag, url] };
```

Two problems for a *raise-the-window* press, as opposed to the join-a-meeting press this
was written for:

- **`-n` is actively wrong here.** Per `open(1)` it forces a new instance. For
  next-meeting's tier-2 join that is harmless (the second process forwards its argv through
  the singleton and exits), but it is the opposite of the intent when the goal is focus.
- **`url` as a bare positional is the tab path** (§1). It has to become
  `--app-id=<app id>` for the app window to be targeted.

Two candidate argv shapes, both fitting the existing `buildOpenArgv` table and its injected
`exec` seam unchanged:

**A. Chrome CLI, cross-platform (recommended):**

```
darwin : open -a "Google Chrome" --args --profile-directory=<profile> --app-id=<app id>
linux  : google-chrome --profile-directory=<profile> --app-id=<app id>
win32  : chrome --profile-directory=<profile> --app-id=<app id>
```

**B. macOS shim, darwin only:**

```
open -b com.google.Chrome.app.<app id>
```

| | A — `--app-id` | B — `open -b <shim>` |
|---|---|---|
| Focuses existing window | Yes, via `WebAppLaunchProcess` + `focus-existing` (§3) | Yes, via `OnShimReopen` → `Show()` (§4) |
| Behaviour if manifest loses `launch_handler` | new app window (`kNavigateNew`) | still reuses (shim path is not `launch_handler`-driven) |
| Profile targeting | explicit `--profile-directory` | none — shim decides (§7) |
| Portability | all three platforms, one argv table row per OS, mirrors today's structure | macOS only; Linux/Windows need shape A anyway |
| Discovery cost | app id | app id **and** bundle path / channel-dependent folder name |
| Failure mode when app not installed | Chrome logs and does nothing visible | `open` exits non-zero → rejects → existing tier-1 fallback fires |
| Unit-testability | pure argv, same as today | pure argv, same as today |

**Recommendation: shape A**, with shape B as an optional macOS refinement only if a live
probe shows A misbehaving. A keeps one mechanism across three platforms, keeps
`--profile-directory` (which the existing `open: { browser, profile }` feed config already
speaks — see [`profile-open.ts:26-30`](../../packages/plugin/src/open/profile-open.ts)),
and needs no knowledge of the "Chrome Apps.localized" layout. B's one genuine advantage is
that it does not depend on Google keeping `focus-existing` in Chat's manifest.

Note the `BrowserId` enum already covers chromium/edge/brave; `--app-id` is a Chromium
switch, so shape A generalises across the family unchanged, whereas B's
`com.google.Chrome.app.` prefix is per-vendor (`BaseBundleID()`), and the folder name is
per-channel.

## 6. Getting the app id

Chromium derives web app ids exactly as it derives extension ids, via
[`components/crx_file/id_util.cc`](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc):

```cpp
std::string GenerateId(base::span<const uint8_t> input) {
  return GenerateIdFromHash(crypto::hash::Sha256(input));
}
std::string GenerateIdFromHash(base::span<const uint8_t> hash) {
  std::string result = base::HexEncode(hash.first(kIdSize));   // kIdSize == 16
  ConvertHexadecimalToIDAlphabet(&result);                      // '0'..'f' -> 'a'..'p'
  return result;
}
```

**But do not rely on computing it.** Empirically, hashing the manifest id Chat currently
serves does *not* reproduce the installed id:

```
$ printf '%s' 'https://chat.google.com/' | shasum -a 256 | cut -c1-32 \
    | tr '0123456789abcdef' 'abcdefghijklmnop'
ngocbdfnlmfdaldfkadhdklddjcofnjp     # installed id is pommaclcbfghclhalboakcipcmmndhcj
```

Nor do `https://mail.google.com/chat/`, `https://chat.google.com/u/0/`, or the bare
origin. *Inference, not verified:* this install predates or differs from the currently
served `id`, or was migrated (the manifest carries
`"migrate_from":[{"id":"https://mail.google.com/chat/","behavior":"force"}]`). Either way
the derivation is not a safe client-side computation.

**Discover it instead**, in descending order of robustness:

1. `CrAppModeShortcutID` in the shim's `Info.plist` (§4) — also gives you
   `CrAppModeShortcutURL`, so you can *match* a shim to `chat.google.com` rather than
   hardcode a name.
2. `chrome://web-app-internals` in the target profile.
3. A plugin setting, entered once by the user — cheapest, and consistent with how the
   next-meeting feed already carries `open: { browser, profile }` as configuration rather
   than discovery.

## 7. Profiles

The Chat shim on this machine is **multi-profile** (no profile component in its bundle id,
§4). `open -b <shim>` therefore carries no profile selector: `AppShimManager` resolves it
from its own registry (`LoadAndLaunchApp()` is called "with an empty profile path for
multi-profile apps"), which can mean the last-active profile — or a profile picker. For a
one-press deck key on a machine with several Chrome profiles (this one has at least
`Default` and `Profile 4`), that is a real behavioural difference.

Shape A has no such ambiguity: `--profile-directory=<profile>` composes with `--app-id`
exactly as it does in Chrome's own generated shortcuts (§2), and
`ProcessCommandLineAlreadyRunning` resolves the startup profile from the forwarded command
line. This is a second reason to prefer A.

This also flags an unresolved item already listed on #104 ("Multiple profiles / multiple
Chat windows"): the *focus* mechanism has to agree with whichever profile's content script
reported the unread count.

## 8. What still needs an empirical probe

I could not test against the live machine's UI. Each of these is one command; run them
with the Chat app window **open** and Chrome running.

1. **Confirm the tab-not-focus failure (§1).** Expected: a new tab appears in a browser
   window; the Chat app window is not raised.
   ```
   open -a "Google Chrome" --args --profile-directory="Profile 4" https://chat.google.com/
   ```
2. **Confirm `--app-id` focuses.** Expected: the existing Chat app window comes to the
   front, **no** new window, **no** new tab.
   ```
   open -a "Google Chrome" --args --profile-directory="Profile 4" \
     --app-id=pommaclcbfghclhalboakcipcmmndhcj
   ```
   If a *second* Chat window appears instead, `focus-existing` is not being honoured on
   the CLI path and shape B becomes the recommendation.
3. **Confirm the shim route.** Expected: identical to (2).
   ```
   open -b com.google.Chrome.app.pommaclcbfghclhalboakcipcmmndhcj
   ```
4. **Confirm the profile that owns the app id**, and that the id above is the one the
   extension will be talking to: open `chrome://web-app-internals` and search for
   `chat.google.com`.
5. **Confirm behaviour with the window *closed* but Chrome running** — expected: the app
   window opens (not a tab) for both (2) and (3).
6. **Confirm behaviour with Chrome not running at all** — expected: (3) starts Chrome via
   the singleton-lock path (§4) and opens the app window.

## 9. Impact on #104

**The map's decision survives.** #104 settled that a press "raises the window only", with a
plugin-side launch as the fallback when no Chat client is connected. Nothing here
contradicts that: a mechanism that reliably raises the window **does** exist on macOS, in
two independent forms, both reachable through the existing `openUrl`/`execFile` seam and
both expressible as a pure argv (so `buildOpenArgv`'s unit tests keep working unchanged).

What changes is only the *content* of the fallback:

- The fallback can no longer be "open the Chat URL". `profile-open.ts`'s current
  `["-n", "-a", app, "--args", …, url]` shape would open a stray tab (§1, §5) — precisely
  the bad outcome #106 asked about.
- It becomes "launch the installed app by id", which introduces **one new configuration
  input**: the app id (§6). That is a genuinely new decision for the spec — the plugin
  cannot compute it, and there is no per-URL launch that substitutes for it.
- Secondary consequence: the fallback is now conditional on Chat being **installed as an
  app**. If it is not, `--app-id` matches nothing and the press should degrade to the
  existing tier-1 `openUrl` (a tab), which is at least the current behaviour rather than a
  regression.

Confidence: **high** on §1 and §2 (read from Chromium source at `main`), **high** on §4's
mechanism (source + a live shim process observed on this machine), **medium-high** on §3
(source is unambiguous, but Chat's `focus-existing` is Google's manifest, not a Chrome
guarantee), and **unverified** on the end-to-end user-visible result until §8's probes are
run.
