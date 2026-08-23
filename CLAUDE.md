# callctl — agent guide

Drive a video call from a hardware control surface. This is the TypeScript
monorepo published at **github.com/sigma/callctl**. It supersedes the four legacy
Go/TS repos in the parent `sd-meet/` workspace (`meetremote`, `meetdeck`,
`streamdeck`, `meet-driver-google`) — those are being **retired**; do not port
work back to them or treat them as a live parallel implementation.

Today it drives **Google Meet** from a **Stream Deck** (and **MIDI**), and
reports **Google Chat**'s unread count to a deck key. The brand is
platform/surface-neutral by design; see *Naming* below.

## The pipeline

```
Stream Deck app ──▶ @callctl/plugin ──local ws :2395──▶ @callctl/extension ──DOM──▶ Google Meet
   (runs plugin)      (@callctl/bridge:                  ├─ meet content script       web app
                       many clients, one port)           └─ chat content script ──▶ Google Chat
                                       state flows back the same path ◀──
MIDI input ─────────────────────────────────────────────▶ @callctl/extension (Meet only)
```

A key press → plugin sends a JSON command over the websocket → the extension
clicks the Meet DOM. State changes push back and repaint the deck LEDs.

**The bridge holds many clients, not one.** A Meet tab and a Chat window attach
at the same time and neither evicts the other. Routing is *"send this op to a
client that handles it"*, read off a **derived** capability set the client sends
in a mandatory handshake — the set of ops its plugins actually registered, so it
cannot drift from the operations that exist. `Message.client` addresses one
client explicitly; **absent means last-wins**, which is Meet's original
semantics. See ADR 0001.

## Packages (`packages/*`)

- **`@callctl/protocol`** — the wire contract, imported by every end: `Message`
  envelope, the handshake (`session.ts`), `Command`/`StateEvent`/`StateValue`
  names, reactions, `MeetSelectorConfig`, and the Chat vocabulary (`chat.ts`).
  **Changing a wire string here changes it for both ends at once — that is the
  point.** Ops are namespaced **per surface** (`meet.*`, `chat.*`) because they
  are the bridge's routing keys and must be unique across surfaces. Deliberately
  **runtime-dependency-free**. Nothing here talks to the other packages.
- **`@callctl/bridge`** — the shared multi-client ws server: connection registry,
  handshake parsing, capability routing. Consumed by both `@callctl/plugin` and
  `@callctl/devbridge`, which each used to carry their own copy of the same
  single-connection eviction. `@callctl/bridge/testing` ships the fake client
  both packages' socket-level tests use.
- **`@callctl/plugin`** — the Stream Deck plugin (`@elgato/streamdeck`, rollup).
  Actions defined once in `src/actions/index.ts`; `ToggleAction` carries the
  three-state LEDs. One `Bridge` on :2395, consumed by `MeetRemote` and
  `ChatRemote` (`src/remote/`) — each owns only its own surface's state.
  The manifest is a hand-maintained `dev.yrh.callctl.sdPlugin/manifest.json`
  (UUID namespace `dev.yrh.callctl`).
- **`@callctl/extension`** — Chrome **MV3** (Vite + @crxjs). The functional bridge
  lives in the **content scripts** (`src/content-script.ts` for Meet,
  `src/chat-content-script.ts` for Chat), NOT the service worker — which does
  one thing only, focusing a window on `chat.raise`, because `chrome.windows` is
  not callable from a content script. Meet is driven by `src/meet/` (model +
  api) and `src/plugins/*` (core/hand/react/selectors, + dev-only debug); Chat
  by `src/chat/` (roster, account, selectors).
  Surface-neutral machinery lives in `src/core/`: `bootstrap.ts` (the shared
  content-script startup), `plugin.ts` (`SurfacePlugin`, the interface every
  surface implements), `config.ts`, `disposer.ts`, and `transport/`
  (`WSTransport`, `MidiTransport`, `TransportRegistry`). See ADR 0002.
- **`@callctl/devbridge`** — dev-only tool. A ws bridge that proxies the plugin
  and injects live DOM introspection, exposed over HTTP and MCP. Used to hunt
  selector drift on either surface — every route takes an optional
  `?client=<id>`, and `/clients` is where you find one. Debug surface ships only
  in non-production extension builds.

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
- **DOM selectors drift.** Google renames aria-labels, so a command builds but
  clicks nothing — the likeliest "it's broken". Don't guess; find current values
  with the dev bridge (`curl localhost:2397/dump?q=<term>`). The match strings
  are **config-over-the-wire, per surface** (`MeetSelectorConfig` /
  `ChatSelectorConfig`, with their own registries and their own
  `meet.selectors` / `chat.selectors` storage keys): push a `setSelectors`
  override and it applies on the next command or observation, no rebuild/reload.
  Fold confirmed fixes into the `DEFAULT_*_SELECTORS`.
- 🔴 **Chat's unread signal is *rendered* text, read *on the row*.** Chat ships a
  screen-reader "Unread" marker on **every** row and hides it with CSS, so text
  content reports everything as unread; and rendered text on a hidden element
  falls back to text content, so reading the marker directly is the same bug one
  level down. jsdom implements none of this — the roster takes an injected
  visible-text port, and the CSS semantics is browser truth, **not** unit-tested.
  The generated class names reproduce the same partition but are regenerated per
  deploy; they are in the research notes for diagnosis only.
- **The transport registry fans `installHooks` once per transport.** Model
  change callbacks (`onMuteStateChange`, `onHandStateChange`, the Chat roster's
  `onChange`) must be **additive subscriptions** (a Set of listeners), never a
  single settable field — else the no-op MIDI transport clobbers the websocket's
  state push and the LEDs go stale. `Transport.onConnect` *is* a single settable
  field, so exactly one plugin per surface may own it.
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
were deliberately not renamed. A second surface sits **beside** the Meet code
(`ChatRemote`, `src/chat/`), never on top of it; what both implement gets a
neutral name (`SurfacePlugin`, `src/core/`, `@callctl/bridge`).

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
