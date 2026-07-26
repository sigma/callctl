# callctl — agent guide

Drive a video call from a hardware control surface. This is the TypeScript
monorepo published at **github.com/sigma/callctl**. It supersedes the four legacy
Go/TS repos in the parent `sd-meet/` workspace (`meetremote`, `meetdeck`,
`streamdeck`, `meet-driver-google`) — those are being **retired**; do not port
work back to them or treat them as a live parallel implementation.

Today it drives **Google Meet** from a **Stream Deck** (and **MIDI**). The brand
is platform/surface-neutral by design; see *Naming* below.

## The pipeline

```
Stream Deck app ──▶ @callctl/plugin ──local ws :2395──▶ @callctl/extension ──DOM clicks──▶ Google Meet
   (runs plugin)      (ws server)                        (Chrome MV3, ws client)            web app
                                       state (mic/camera/hand) flows back the same path ◀──
MIDI input ─────────────────────────────────────────────▶ @callctl/extension
```

A key press → plugin sends a JSON command over the websocket → extension clicks
the Meet DOM. State changes push back and repaint the deck LEDs.

## Packages (`packages/*`)

- **`@callctl/protocol`** — the wire contract, imported by both ends: `Message`
  envelope, `Command`/`StateEvent`/`StateValue` names, reactions, and the
  `SelectorConfig`. **Changing a wire string here changes it for both ends at
  once — that is the point.** Nothing else here talks to the other packages.
- **`@callctl/plugin`** — the Stream Deck plugin (`@elgato/streamdeck`, rollup).
  Actions defined once in `src/actions/index.ts`; `ToggleAction` carries the
  three-state LEDs; `MeetRemote` (`src/remote/`) is the ws **server** on :2395.
  The manifest is a hand-maintained `dev.yrh.callctl.sdPlugin/manifest.json`
  (UUID namespace `dev.yrh.callctl`).
- **`@callctl/extension`** — Chrome **MV3** (Vite + @crxjs). The functional bridge
  lives in the **content script** (`src/content-script.ts`), NOT the service
  worker (`src/background.ts` only logs). Meet is driven by `src/meet/` (model +
  api) and `src/plugins/*` (core/hand/react/selectors, + dev-only debug).
  Transports in `src/transport/`: `WSProtocol`, `MidiProtocol`, `MultiProtocol`.
- **`@callctl/devbridge`** — dev-only tool. A ws bridge that proxies the plugin
  and injects live Meet DOM introspection, exposed over HTTP and MCP. Used to
  hunt selector drift. Debug surface ships only in non-production extension
  builds.

## Conventions

- **Version control is [jj](https://github.com/jj-vcs/jj)** (colocated with git;
  remote `origin`, bookmark `main`). Use jj, not raw git. Anchor to the repo root
  with `jj root`. **Work in granular changes** — one logical step each, recorded
  early (`jj commit`/`jj new`/`jj describe`); reshape freely before pushing.
- **Commands are not on the bare PATH** — everything runs inside the Nix devShell.
  `direnv allow` once, or prefix: `nix develop 'path:.' --command <cmd>` (use
  `path:.` — flake files may be untracked and plain `.` fails).
- **`just` is the task runner** (`just` alone lists recipes). Gate before
  committing: `just build && just test && just check` (and `just validate` for
  manifest changes). Formatting/lint is **biome** (2-space, double quotes,
  semicolons); import-sort fixes need `biome check --write`, not `just fmt`.
- Tests are **vitest** (jsdom for the extension). The protocol package has no
  test runner — test its logic from a consumer package.
- **Ports:** local bridge ws **2395** (plugin server ⇄ extension client,
  configurable in the extension Options); dev bridge uses **2396** (proxy) and
  **2397** (HTTP). See `docs/development.md`.

## Load-bearing gotchas

- **The Stream Deck *app* runs the plugin, not a terminal.** `just dev-plugin` is
  only a rebuild+restart watcher. Likewise Chrome runs the extension. Manifest
  changes (action set, UUID, `DisableAutomaticStates`) need a **re-link**
  (`just link`) + restart, not just a rebuild.
- **Content-script reloads disconnect the call.** Reloading the *extension* does
  NOT re-inject content scripts (old code keeps running, call survives) — your
  changes are not live. Only a **Meet tab reload** picks up content-script
  changes, and it drops/rejoins the call. `just dev-extension` (HMR) auto-reloads
  the tab.
- **Meet DOM selectors drift.** Google renames aria-labels, so a command builds
  but clicks nothing — the likeliest "it's broken". Don't guess; find current
  values with the dev bridge (`curl localhost:2397/dump?q=<term>`). The match
  strings are **config-over-the-wire** (`SelectorConfig` / `SelectorRegistry`):
  push a `setSelectors` override and it applies on the next command, no
  rebuild/reload. Fold confirmed fixes into `DEFAULT_SELECTORS`.
- **`MultiProtocol` fans `installHooks` once per transport.** Model change
  callbacks (`onMuteStateChange`, `onHandStateChange`) must be **additive
  subscriptions** (a Set of listeners), never a single settable field — else the
  no-op MIDI transport clobbers the websocket's state push and the LEDs go stale.
- **Toggle LEDs use `DisableAutomaticStates`.** The Elgato SDK blind-cycles a
  multi-state action's LED on press; without this the LED flickers and can settle
  wrong. Real Meet state drives it via `ToggleAction#refresh()` only.
- **Hand state has no `aria-pressed`** — key off the button label ("Lower hand"
  present ⇒ raised). Meet re-renders controls and can swap `<body>`, so DOM
  observers watch broadly from `document.documentElement` and re-scan.

## Naming (platform vs. brand)

The **brand** is neutral (`@callctl/*`, `dev.yrh.callctl`) so it generalizes over
surfaces and platforms. **Platform-specific code keeps its platform name** —
`MeetRemote`, `src/meet/`, the Google Meet driver are genuinely Meet-specific and
were deliberately not renamed. When adding a second platform, put it beside the
Meet code, don't rename the Meet code to be generic.

Full dev/debug procedures (watchers, bridge topologies, HTTP/MCP API, the
selector-fix loop): **[`docs/development.md`](docs/development.md)**.

## Agent skills

### Issue tracker

Issues live in the `sigma/callctl` GitHub Issues, managed via the `gh` CLI;
external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
