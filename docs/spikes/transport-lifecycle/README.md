# SPIKE: Live transport lifecycle

> Throwaway prototype for [#3 — Live transport lifecycle: dynamic
> enable/disable/reconfigure](https://github.com/sigma/callctl/issues/3),
> keystone of [map #1](https://github.com/sigma/callctl/issues/1). Code:
> [`spike.ts`](./spike.ts). Not wired into the build — it exists to make the
> mechanism concrete enough to react to.

## Decisions (locked — from the #3 exchange)

1. **Transport-owned teardown** (not registry-owned).
2. **Port change is an in-place `retarget`, not disable+enable** — reinstalling
   every plugin for a mere reconnection is ugly; the live transport redials
   itself and keeps its installed hooks/handlers.
3. **`MultiProtocol` is retired** — the registry owns the fan-out; it is *not*
   itself a `Transport`.
4. **`detach()` is permanent for an instance**; re-enable builds a fresh one.

## The problem in one sentence

Installing a plugin onto a transport is **fire-and-forget**, so there is
nothing to undo — which is exactly what "disable a transport at runtime"
requires.

Concretely, today (`content-script.ts` → `App.run` → per-transport
`acceptPlugin`):

- `installHooks(t)` calls `model.onMuteStateChange(listener)` — which returns
  `void`. The listener joins a `Set` that is **never cleared**
  (`meet/model.ts:94`).
- `installHooks(t)` sets `t.onConnect = …` — overwritten, never restored.
- `installHandlers(t)` fills per-transport handler maps (`WSProtocol#handlers`,
  `MidiProtocol.midiMap`) — never emptied.
- `MultiProtocol([...])` is a **static array**; `App.run()` fans `acceptPlugin`
  **once**. No add, no remove. A port change today just calls `shutdown()` and
  asks the user to **reload the tab** (`content-script.ts:34-40`).

So a naive "disable then re-enable" would (a) leave a dead pusher wired into
the model forever and (b) on re-enable, add a *second* one → duplicate/stale
LED pushes. That's the `MultiProtocol`-fans-`installHooks`-once gotcha, now
biting in reverse.

## The mechanism (what the spike demonstrates)

One idea, applied three times: **every install step returns a disposer, and
the transport owns the disposers installed on it.**

1. **Model subscriptions return their unsubscribe.** `onMuteStateChange` /
   `onHandStateChange` stay additive (still a `Set` — the gotcha stands) but
   now hand back a `Disposer` that removes *just that* listener. This is the
   single load-bearing edit.

2. **The transport is the lifecycle unit and owns its teardown.** A
   `LiveTransport` gains `onDetach(d: Disposer)` — a disposer *sink* — and
   `detach()`, which runs every parked disposer, clears its handler map, and
   closes the pipe. `handle()` self-parks its own removal, so handler cleanup
   is automatic.

3. **A `TransportRegistry` replaces the static array.** Keyed by stable id
   (`"ws"`, `"midi"`): `enable(id, factory)` builds a transport and installs
   every plugin against it; `disable(id)` calls `detach()` (one call undoes
   everything); `retarget(id, config)` re-parameterizes a **live** transport in
   place, leaving its installed plugins untouched.

`retarget` takes a per-transport `Config` (WS = new port; MIDI (#5) = the
checked device set), so the same registry method covers both without churn.

Everything the map asks for is then a *caller* of this, with no special path:

| Map control | Registry call |
|---|---|
| Stream Deck on/off | `enable("ws", …)` / `disable("ws")` |
| MIDI on/off (#5) | `enable("midi", …)` / `disable("midi")` |
| Dev-bridge port switch (#6) | `retarget("ws", devPort)` |
| Change plugin port (Options, #7) | `retarget("ws", newPort)` |
| MIDI device re-select (#5) | `retarget("midi", checkedDeviceSet)` |

The dev-bridge switch being *just a retarget* is the nice result: the ws
reconnect is transparent (only that socket blips; the content script — and thus
the call — never reloads; **plugins are not re-installed**), and the reconnect
fires `onConnect`, which re-pushes state so the LEDs start correct.

## Why transport-owned teardown

The rejected alternative was **registry-owned** (registry keeps a
`(transportId, plugin) → Disposer[]` map). Transport-owned wins because it
localizes "what must be undone" next to "what was done": `detach()` is
self-contained, and a newly-added transport type can't forget to be cleanable.
Cost, accepted: `Transport` grows `onDetach`/`detach`, and `installHooks` routes
its cleanup through the sink.

## Downstream impact (what T4/T5/#6/#7 inherit from this)

- `MeetPlugin.installHooks` cleanup now routes through `t.onDetach(...)`. Only
  `installHooks` changes in spirit; `installHandlers` is unaffected because
  `handle()` self-disposes. Plugins with empty hooks (`selectors`, `react`,
  `debug`, `hand`'s handlers) are untouched.
- `Model.onMuteStateChange` / `HandModel.onHandStateChange` change return type
  `void → Disposer`. Small, mechanical, but touches the model interfaces #5
  reads.
- The **widget (#4)** binds its toggles/checkboxes straight to
  `registry.enable/disable/retarget` + `registry.isEnabled`.
- **MIDI (#5)** and **dev-bridge (#6)** become registry callers; MIDI's
  per-device binding lives *inside* the `"midi"` transport, so re-select is a
  `retarget("midi", checkedDeviceSet)` and hotplug is handled internally.
- `MultiProtocol` is retired in favor of `TransportRegistry` (not itself a
  `Transport` — nothing downstream needs the fan-out to *be* a transport once
  the registry owns it).

## Implementation

The mechanism graduates into a `wayfinder:task` ticket that builds it for real
(disposer-owning transports, the registry, `WSTransport.retarget`, retiring
`MultiProtocol`) and re-blocks #5/#6. See the map's Decisions-so-far.
