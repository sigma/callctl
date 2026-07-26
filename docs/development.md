# Development & debugging

Precise reference for the dev/debug processes across the monorepo. All commands
assume the nix devShell (`pnpm`/`just`/`node` are **not** on the bare PATH):

- `direnv allow` once in `deck/`, **or**
- prefix every command: `nix develop 'path:.' --command <cmd>` (use `path:.` — the
  flake files may be untracked and plain `.` fails).

Run `just` with no args to list every recipe.

## The moving parts

| Component | Who runs it | Listens / connects | Notes |
|---|---|---|---|
| **Stream Deck plugin** (`@meetdeck/plugin`) | the **Stream Deck app** (auto-launches the installed `.sdPlugin`) | **ws server on `:2395`** (the Meet bridge port) | Runs whenever the app is running + the plugin is linked — **no terminal needed**. Also talks to Elgato on a separate `-port` (e.g. `:28196`); that is the SDK channel, not our bridge. |
| **Chrome extension** (`@meetdeck/extension`) | Chrome (loaded unpacked) | **ws client**, dials the port in its Options (default **`2395`**) | The functional bridge lives in the **content script**. |
| **Dev bridge** (`@meetdeck/devbridge`) | you (optional) | ws server + ws client + HTTP | Proxy + live DOM debug. See below. |

Key point: `just dev-plugin` / `dev-extension` / `dev-bridge*` are **watchers/tools**,
not the thing that makes a component exist. The plugin exists because the Stream
Deck app runs it; the extension exists because Chrome loaded it.

## Ports

| Port | Bound by | Purpose |
|---|---|---|
| `2395` | Stream Deck plugin **or** `dev-bridge` (not both) | Meet remote-control websocket (server side) |
| `2396` | `dev-bridge-proxy` | extension-facing ws when proxying (point the extension Options here) |
| `2397` | dev bridge | HTTP debug API |

## Watchers (each in its own terminal, all optional)

```
just dev-plugin        # rollup -w: rebuild plugin on save + `streamdeck restart`.
                       #   Needed ONLY when editing plugin code. Does NOT start the
                       #   plugin (the Stream Deck app does).
just dev-extension     # vite/crxjs dev server + HMR for the extension content script.
just dev-bridge        # dev bridge, debug-only, binds :2395  (see topology A)
just dev-bridge-proxy  # dev bridge, proxy on :2396 → plugin :2395 (see topology B)
```

## Extension build modes (DebugPlugin gating)

The DebugPlugin (live DOM introspection over the bridge) is included only when
`import.meta.env.MODE !== "production"`:

| Command | MODE | DebugPlugin | HMR | Load target |
|---|---|---|---|---|
| `just dev-extension` | `development` | ✅ | ✅ | `packages/extension/dist` (auto-reloads) |
| `just build-extension-debug` | `debug` | ✅ | ❌ | `packages/extension/dist` (static) |
| `just build-extension` | `production` | ❌ | ❌ | `packages/extension/dist` (ships clean) |

`just load-extension` prints the `dist/` path for chrome://extensions → *Load unpacked*.
A production build's debug channel **times out by design** — a handy "is a
debug build actually live?" signal.

## Reload semantics (important — this bit is subtle)

- **Reloading the extension** (chrome://extensions) restarts its service worker
  but does **not** re-inject content scripts into already-open tabs. The old
  content script keeps running (its websocket stays connected), so commands still
  flow — but your **code changes are NOT live**. It also does **not** disconnect
  the call.
- **Reloading the Meet tab** re-injects the new content script (picks up code
  changes) **and** drops/rejoins the call. This is unavoidable for any
  content-script change.
- `just dev-extension` (HMR) auto-reloads the tab on a content-script change —
  same disconnect cost, but automatic. Prefer it while iterating.
- **Manifest action-set changes** (e.g. adding/removing reaction buttons) are
  picked up only on **re-link/reinstall** (`just link`), not on a plugin restart.

## Debug bridge

The bridge speaks the same protocol as the plugin, so the extension connects to
it unchanged. It can also proxy to the real plugin and inject debug requests.

**Topology A — debug only** (`just dev-bridge`, binds `:2395`):
requires the Stream Deck plugin **not** running (port clash). Extension Options
stay at `2395`.

```
Chrome extension ──dials :2395──▶ dev bridge ──▶ HTTP :2397
```

**Topology B — transparent proxy** (`just dev-bridge-proxy`): Stream Deck keeps
working. Set the extension's Options port to **2396**.

```
Chrome extension ─dials :2396─▶ dev bridge ─dials :2395─▶ Stream Deck plugin
                                    │
                                    └─▶ HTTP :2397 (debug) — proxied traffic relayed both ways
```

### HTTP API (curl-friendly, returns JSON)

```
GET  /health | /state                 connection + cached mic/camera/hand state
GET  /dump?q=<substr>                  every control (buttons/[aria-label]/[data-is-muted])
                                       with full attribute map + truncated outerHTML;
                                       optional aria-label/text filter
GET  /query?selector=<css>            controls matching a CSS selector
GET  /click?selector=<css>            click the first match
GET  /command?event=<e>&data=<d>      inject a raw protocol command at the extension
POST /command  {"event":"…","data":"…"}
GET  /selectors                       read the extension's live selector config
POST /selectors  {"handRaise":"…",…}  push a partial selector override (drift fix)
```

Diagnostic idioms:
- `curl 'localhost:2397/state'`, then `curl 'localhost:2397/command?event=toggleMic'`,
  then `curl 'localhost:2397/state'` again **without** re-asking → tells you whether a
  change auto-pushed (state-sync debugging).
- `curl 'localhost:2397/dump?q=hand'` → find a control's current aria-label/attrs
  (selector-drift debugging).

### MCP server

`.mcp.json` registers a stdio MCP server exposing the same ops as tools
(`meet_dump`, `meet_query`, `meet_click`, `meet_command`, `meet_state`,
`meet_get_selectors`, `meet_set_selectors`). It runs its own bridge, so **don't
run it and an HTTP `dev-bridge` at the same time** (port clash). Requires
`just build-devbridge` first, and a Claude Code session reload to pick up
`.mcp.json`.

## Config-over-the-wire selectors (fixing drift without a reload)

Every Meet control the extension drives is matched by an **accessible-name
substring** (or, for mic/camera, an aria-label substring on `[data-is-muted]`).
Google renames these over time — the usual cause of "a command builds but clicks
nothing". Those substrings are **runtime data**, not hardcoded: they live in a
`SelectorConfig` the extension holds in a `SelectorRegistry`, seeded from
`DEFAULT_SELECTORS` (`@meetdeck/protocol`) and overridable over the wire.

Keys: `mic`, `camera`, `leave`, `participants`, `chat`, `handRaise`, `handLower`,
`reactionOpener`.

Wire protocol (rides the normal websocket):

```
→ {event:"getSelectors"}                       ← {event:"selectors", data:<full JSON>}
→ {event:"setSelectors", data:<partial JSON>}  ← {event:"selectors", data:<merged JSON>}
```

Because every DOM lookup reads the registry **fresh**, a pushed override takes
effect on the *next command* — **no rebuild, no tab reload, no dropped call**.
The extension also persists overrides to `chrome.storage.local` (`selectors`
key) and re-applies them on load, so a field fix survives reloads. A malformed or
empty value is ignored (`mergeSelectors`), so a bad push can never blank a
selector out.

**The drift-fix loop** (with a bridge up and a call open):

```
curl 'localhost:2397/dump?q=hand'                     # find the real aria-label
curl 'localhost:2397/selectors'                        # see what's matched now
curl -X POST localhost:2397/selectors \
     -d '{"handRaise":"Raise hand","handLower":"Lower hand"}'
# → merged config echoed back; retry the deck button — no reload needed
```

Once a fix is confirmed live, fold it into `DEFAULT_SELECTORS` so a clean install
gets it too (that part *is* a code change + release, but no longer time-critical).

## Typical loops

- **Iterate on extension DOM logic:** terminal 1 `just dev-extension`; terminal 2
  `just dev-bridge-proxy`; set extension Options → `2396`; load `dist/` unpacked.
  Edit → HMR reloads the tab → drive/inspect via `curl :2397`.
- **Iterate on plugin code:** `just dev-plugin` (rebuild + restart). Add/remove
  actions ⇒ `just link` to re-register the manifest.
- **Quick DOM peek, no Stream Deck:** stop the plugin, `just dev-bridge`, keep
  extension Options at `2395`.

## Quality gate

```
just build     # pnpm -r build  (protocol → plugin/extension/devbridge)
just test      # pnpm -r test   (vitest)
just check     # biome lint
just fmt       # biome format --write
just validate  # streamdeck validate the plugin bundle
```
