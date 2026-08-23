# 2. A surface-neutral extension core beside `src/meet/`

**Status:** accepted (2026-08-23)
**Origin:** [Where is the seam between the surface-neutral extension core and src/meet/?](https://github.com/sigma/callctl/issues/108),
on wayfinder map [Map: Google Chat unread](https://github.com/sigma/callctl/issues/104).

## Context

The Chrome extension is shaped entirely around Google Meet: one content script, one plugin
set, one selector registry. Adding a `chat.google.com` surface needs a seam.

Investigating the Chat roster ([#112](https://github.com/sigma/callctl/issues/112)) turned
three assumptions into measurements:

- 🔴 **The Meet plugins throw on a non-Meet page.** Pointing `content-script.ts` at Chat dies
  with `Uncaught x: No mute/unmute button found for microphone` from `newCorePlugin()`,
  **before the websocket is dialled** — so the whole script is dead, silently, unless you
  open the extension's error page. Prior analysis had predicted a harmless no-op.
- 🔴 **The selector storage key is shared.** Overrides persist under the bare key `selectors`,
  and `chrome.storage.local` is one store per extension install shared by both content
  scripts — so a Chat write would **clobber Meet's selectors**.
- 🟡 **crxjs collapses `web_accessible_resources`** when two `content_scripts` entries share
  one script file: only the last entry's `matches` survives, silently breaking the other
  surface. Separate entry scripts produce correct WAR entries for both.

Against that, the transport layer turned out to be **already surface-neutral**: `Transport`,
`BaseTransport`, `TransportRegistry` and `Disposer` touch only `Message` and the plugin
interface. The Meet-ness lives in the *names* and the plugin set.

## Decision

### `src/core/`, a directory — not a workspace package

Moves into `src/core/`: `transport/` (whole directory), `disposer.ts`, the plugin interface,
the config envelope, and a new `bootstrap.ts`. `meet/` and the Meet plugins stay put;
`chat/` appears beside them.

**Deliberately not a package**, breaking symmetry with
[`@callctl/bridge`](0001-multi-client-capability-handshake.md): that one has two consumers in
different packages, this has exactly one — the extension. A package would buy a build
boundary and a version surface for nothing. This is a `git mv`.

### `MeetPlugin` → `SurfacePlugin`

It is the one interface both surfaces implement. `CLAUDE.md`'s naming rule exists to stop
*Meet-specific* code being genericised; this interface is not Meet-specific, and leaving
"Meet" in the name of the thing Chat implements is the confusion that rule prevents.

### `ID()` splits from MIDI addressing

`ID()` currently conflates plugin identity with a MIDI CC number (`midi-transport.ts` selects
the plugin by it). `SurfacePlugin` carries **identity only**; MIDI addressing becomes an
**optional capability** a plugin opts into, and `MidiTransport` maps over just those.

Chat plugins are the first with no meaningful answer to "what is your MIDI CC number", and
leaving it mandatory means inventing junk values MIDI would happily route to.

### Selectors split per surface — types, storage keys, and ops

Separate config *types*, separate storage keys, separate ops. `chat.setSelectors` writes a
`ChatSelectorConfig` under its own key.

Beyond fixing the storage collision, **they are not the same kind of value**: Meet's are
accessible-name substrings; Chat's are a CSS row selector plus locale-sensitive rendered text
tokens. One `Record<_, string>` covering both makes the type lie about what its values mean.
See `docs/spec/chat.md` §7.

### One entry script per surface, over a shared `core/bootstrap.ts`

A single host-branching entry is not available (crxjs WAR collapse; Meet plugins throw). What
the surfaces share is real: the ~60 lines of `content-script.ts` that load config, build the
registry, enable transports and react to `storage.onChanged` are entirely surface-agnostic.
`bootstrap.ts` takes a plugin factory and does that work — so the next config option cannot
be added to one script and forgotten in the other.

### MIDI stays Meet-only

If both content scripts bound MIDI, **both would receive every CC message**, while sharing one
global plugin-id namespace with no coordination. The Chat bootstrap enables **ws only**.

### The `selectors` singleton pattern stays, per surface

`meet/selectors.ts` keeps its module-level instance; `chat/selectors.ts` gets its own. This is
safe for a reason worth recording: **the two content scripts run in separate JavaScript
realms**, so a per-surface module singleton cannot collide with the other surface — there is
no shared process.

### Sequencing: prerequisite refactor, landed on its own

Extraction, renames, the `ID()` split and the `meet.*` op prefixing
([ADR 0001](0001-multi-client-capability-handshake.md)) land **first**, with Meet still
working and no Chat code. The correctness criterion is crisp and independently checkable —
*Meet still works, nothing else changed* — and interleaving would make a Meet regression
indistinguishable from a Chat bug.

The usual argument for interleaving (a seam designed without a second consumer is guesswork)
is weak here: [#112](https://github.com/sigma/callctl/issues/112) and
[#113](https://github.com/sigma/callctl/issues/113) established concretely what the second
consumer needs.

## Consequences

- A large, mostly mechanical diff, verifiable by "Meet still works".
- The widget and `isMeetingUrl` stay Meet-only.
- The config envelope (`ws`, `midi`) remains shared storage by nature, so the ws toggle
  governs both surfaces at once.
- Existing selector overrides persisted under the bare `selectors` key need migrating to the
  Meet-scoped key, or they are silently ignored on first run after the refactor.

## Alternatives considered

| Option | Why not |
|---|---|
| Duplicate the thin parts into `src/chat/` | The selector registry and its config-over-the-wire override loop are the repo's hardest-won asset; Chat needs them for the same reason Meet does. |
| One content script branching on `location.host` | Ruled out by the crxjs WAR collapse, before taste enters into it. |
| A `@callctl/surface` workspace package | One consumer. Build boundary and version surface for nothing. |
| Namespaced keys in one flat `SelectorConfig` | Leaves one config object each surface half-ignores, and does not fix the storage collision. |
| Nested `Record<surface, config>` | Same, and forces every push to carry the other surface's data. |
| Drop `ID()` entirely, with a MIDI-owned plugin→CC table | Cleanest in principle, but relocates a mapping that currently lives next to each plugin — a bigger behavioural diff than this refactor should carry. |
