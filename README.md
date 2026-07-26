# callctl

Drive a video call from a hardware control surface. Press a key on an Elgato
**Stream Deck** (or a **MIDI** pad) to mute your mic, toggle your camera, raise
your hand, fire a reaction, or leave — and watch the keys light up to reflect the
call's real state.

Today callctl drives **Google Meet**. The name is deliberately neutral: the plan
is to grow along two axes — more **control surfaces** (Stream Deck first, MIDI
next) and more **conferencing platforms** — without the brand pinning it to
either.

## How it works

A key press travels from the surface to the Meet tab and back:

```
 ┌───────────────┐  Elgato SDK ws   ┌───────────────┐  local ws :2395  ┌────────────────────┐   DOM   ┌─────────────┐
 │  Stream Deck  │◀────────────────▶│ @callctl/plugin│◀───────────────▶│ @callctl/extension  │◀───────▶│ Google Meet │
 │ hardware/app  │                  │  (ws server)   │                  │ (Chrome MV3, client)│  clicks │  web app    │
 └───────────────┘                  └───────────────┘                  └────────────────────┘         └─────────────┘
        │ MIDI input ─────────────────────────────────────────────────────▶ │
```

- The **plugin** runs inside the Stream Deck app and hosts a local websocket
  server on port **2395**.
- The **extension** runs in your Meet tab, dials that websocket, and drives Meet
  purely by clicking DOM controls (matched on their accessible names /
  `data-is-muted`). State changes flow back the same way and repaint the keys.
- **MIDI** is an alternate input surface wired straight into the extension.
- The two ends share nothing but the **wire protocol** (`@callctl/protocol`), so
  either can be rebuilt independently.

One nicety: the Meet control selectors are **configuration, not code** — Google
renames its buttons over time, and a drifted selector can be fixed live over the
websocket without rebuilding or reloading (which would drop the call). See
[`docs/development.md`](docs/development.md).

## Packages

| Package | What it is |
|---|---|
| [`@callctl/protocol`](packages/protocol) | The shared websocket contract (event names, message envelope, reactions, selectors). The single source of truth both ends import. |
| [`@callctl/plugin`](packages/plugin) | The Stream Deck plugin: actions, LED state, and the ws server the extension dials. |
| [`@callctl/extension`](packages/extension) | The Chrome MV3 extension: dials the ws (and MIDI), and drives the Meet DOM from the content script. |
| [`@callctl/devbridge`](packages/devbridge) | Dev-only. Proxies the plugin websocket and exposes live Meet DOM introspection over HTTP and MCP — for debugging selector drift. |

## Controls

Mic on/off/toggle · camera on/off/toggle · raise/lower/toggle hand · leave call ·
toggle chat · toggle participants · reactions (💖 👍 🎉 👏 😂 😮 😢 🤔 👎, skin-tone
aware). The three toggles carry live LED state (on / off / disconnected).

## Install (users)

You need the Elgato Stream Deck app and Chrome. From a clone:

```sh
pnpm install
pnpm -r build
```

1. **Extension** — load `packages/extension/dist/` unpacked at
   `chrome://extensions` (Developer mode → *Load unpacked*), then open a Meet call.
2. **Plugin** — link it into the Stream Deck app:
   `pnpm -F @callctl/plugin run link`. Add the callctl actions to your deck.
3. Both default to port **2395**; the extension's Options page can change it.

## Develop

The dev environment is a Nix flake + `just`. `direnv allow` (or
`nix develop`) drops you into a shell with `pnpm`, `just`, `node`, and `biome`.

```sh
just            # list every recipe
just build      # build all packages
just test       # vitest across packages
just check      # biome lint
just dev-plugin      # rebuild + restart the plugin on save
just dev-extension   # vite/crxjs dev server + HMR for the extension
```

The full dev/debug reference — watchers, ports, reload semantics, the debug
bridge (HTTP + MCP), and the live selector-fix loop — is in
[`docs/development.md`](docs/development.md).

## Status

Early and Meet-only. The architecture is built for more surfaces and platforms,
but only Google Meet + Stream Deck/MIDI are wired today. Not yet licensed — no
usage rights are granted until a `LICENSE` is added.
