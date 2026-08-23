# 1. Multi-client bridge with a derived capability handshake

**Status:** accepted (2026-08-23)
**Origin:** [Design the multi-client capability handshake for the local bridge](https://github.com/sigma/callctl/issues/107),
on wayfinder map [Map: Google Chat unread](https://github.com/sigma/callctl/issues/104).
Amended by [How does the extension discover its own account or domain?](https://github.com/sigma/callctl/issues/117) — see *Consequences*.

## Context

The local bridge on `:2395` keeps **exactly one** connection. `MeetRemote.#onConnection`
is explicit about it:

> Keep a single connection: a new dial-in supersedes the old socket.

That was correct while the extension had one content script, on `meet.google.com`. Adding a
second surface (`chat.google.com`) breaks it immediately: the two clients evict each other
in a loop.

The same single-connection assumption is **duplicated** in `DebugBridge.#onExtension`
(`packages/devbridge/src/debug-bridge.ts`), which does the same `close()`-the-previous
dance. It bit us during [#112](https://github.com/sigma/callctl/issues/112), where the
workaround was "close all Meet tabs".

Two further requirements emerged while designing this:

- **Meet and Chat need opposite routing.** You cannot be in two calls, so a second Meet tab
  is a stale leftover and last-wins is right. But **two Chat windows are legitimate** — a
  work Chrome profile and a personal one — and each must drive its own deck key.
- A hardcoded role enum (`meet` | `chat`) means every new surface is a protocol edit at
  both ends.

## Decision

### Capabilities are derived, not declared

A client's capability set is **the set of op names its plugins registered** —
`[...transport.handlers.keys()]`, populated by `t.handle(op, …)` and complete by the time
`onopen` fires. It is sent in a mandatory handshake.

Routing is then literally *"send `toggleMic` to a client that handles `toggleMic`"*.

There is **no `Command → capability` table** anywhere, and the capability set is
automatically correct the moment someone adds a plugin. A coarse self-declared label
(`"meet"`, `"chat"`) rides along **for logs and UI only** and must never be load-bearing
for routing.

**Consequence: op names are routing keys.** They must be unique across surfaces. See
[ADR 0002](0002-surface-neutral-extension-core.md) and `docs/spec/chat.md` §9 for the
resulting `meet.*` / `chat.*` prefixing.

### Clients are individually addressable; last-wins is the default

`Message` gains an optional `client` field. Commands carry a target; state events carry a
source.

- **Absent `client` ⇒ last-wins.** Today's exact semantics. Every existing Meet action stays
  byte-identical.
- **Present `client` ⇒ precise routing.** Chat keys use this.

### Client identity is an opaque string

Minted once per extension install (`crypto.randomUUID()` into `chrome.storage.local`, which
is per-Chrome-profile) and paired with a human label.

It is typed as an **opaque string, not a UUID**, deliberately: the unit today is the
*profile*, but one profile signed into two accounts yields one install and two Chat windows.
Keeping the id opaque makes adding an account discriminator later a **value** change rather
than a schema change.

### The handshake is mandatory

No handshake, no routing. Both ends ship from this repo and `@callctl/protocol` exists
precisely so a wire change lands on both sides at once; there is no third-party client to
strand.

A stale unpacked extension will silently stop working until reloaded, so this **must** log a
loud, specific line — *"client connected without handshake — reload the extension"* — not
drop silently.

### The connection registry is shared code

A new **`@callctl/bridge`** workspace package holds the client registry, handshake parsing
and routing. Both `MeetRemote` (in `@callctl/plugin`) and `DebugBridge` (in
`@callctl/devbridge`) consume it.

Placement is constrained, not chosen: `plugin` and `devbridge` both depend on
`@callctl/protocol` and `ws`, neither depends on the other, and **`protocol` is deliberately
runtime-dependency-free** — a `ws` server cannot live there without destroying what that
package is for.

### `MeetRemote` splits

`connected` is the forcing function: it must become per-capability
(`bridge.handles("chat.getRoster")`), or a Chat key lights up merely because a Meet tab is
open.

- **`Bridge`** — sockets, handshakes, client registry, routing. Surface-neutral.
- **`MeetRemote`** — a consumer subscribing for Meet events, owning only Meet state, keeping
  its typed accessors (`micState(): boolean`). A future `ChatRemote` sits beside it.

Meet-named and Meet-typed, per `CLAUDE.md`'s rule that platform code keeps its platform name.

## Consequences

- `Message` grows an optional field — a wire change for both ends, which is what
  `@callctl/protocol` is for.
- A new workspace package.
- **The account index must never enter the client id.** [#117](https://github.com/sigma/callctl/issues/117)
  showed `/u/<n>` is a property of the *session*, not the account — Google documents the
  default as "the one you signed in with first" — so an id built on it would re-target every
  deck binding after a different sign-in order. If an account discriminator is ever needed it
  must derive from the **address**.
- Deck keys bind to a client via a Property Inspector dropdown; **unbound means "any client
  with this capability"**, so the single-profile case needs no configuration.

## Alternatives considered

| Option | Why not |
|---|---|
| Curated capability list (`["meet.control"]`) | Needs a hand-maintained `Command → capability` table that can drift from the ops that actually exist. |
| A second websocket port for Chat | Two ports to configure, two reconnect loops, and it does not generalise to a third surface. |
| Chat relays through the Meet content script | Makes Chat silently depend on a Meet tab being open — backwards from how the feature is used. |
| Broadcast commands to every claimant | Two Meet tabs would both receive `toggleMic`, toggling a call you cannot see. |
| Route by `callState` liveness | Couples generic routing to Meet-specific call semantics, and has no answer when no client is in a call. |
| Auto-assign clients to keys by connection order | Connection order depends on which window opened first, so work and personal keys silently swap. |
| Implicit legacy capabilities for un-handshaken clients | Buys compatibility nobody needs, at the cost of a permanent branch in the router and a second forever-supported semantics. |
