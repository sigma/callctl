# Web MIDI output — acquiring, selecting, and sending to `MIDIOutput` ports

> Research asset for [Map: Bidirectional MIDI](https://github.com/sigma/callctl/issues/16),
> ticket [#17](https://github.com/sigma/callctl/issues/17). AFK research.
> Sources: [W3C Web MIDI API](https://www.w3.org/TR/webmidi/) (Editor's Draft / TR),
> cross-checked against the shipped input transport in
> `packages/extension/src/transport/midi-transport.ts` (issue #5).

## TL;DR for the transport design

The output side is a **near-mirror of the input side** and slots into #5's
machinery with almost no new concepts:

- `MIDIAccess.outputs` is a `MIDIOutputMap` — same maplike shape as `inputs`,
  keyed by port `id`. The existing `reconcile()` loop can bind outputs by
  iterating `#access.outputs` instead of `#access.inputs`.
- `onstatechange` **already fires for output ports** (it is a `MIDIPort`-level
  event). The single `onstatechange` handler #5 installs covers both directions
  — no second listener, no new event source.
- Sending is `output.send([status, data1, data2])` — a plain byte array, fire
  and forget. No promise, no ack. This is what `MidiTransport.send()` (today a
  no-op) becomes.
- `matchesMidiDevice()` works **unchanged** on outputs: it keys off
  `{id, name, manufacturer}`, all of which `MIDIOutput` inherits from
  `MIDIPort`. Whether to *reuse* #5's input selection or add a separate output
  selection is the one genuine design choice — see [§4](#4-in-out-port-relationship).
- **LED control does not obviously need SysEx.** RodeCaster smart-pad LEDs are
  driven by ordinary Note-On / Control-Change messages on most Mackie/HUI-style
  surfaces, so `requestMIDIAccess()` (no `{sysex:true}`) is likely sufficient.
  This must be **confirmed by the hardware-capture task**; if the pads only
  accept SysEx, we need `{sysex:true}` and a permission prompt. See [§5](#5-permissions--sysex).

## 1. `MIDIAccess.outputs` and `MIDIOutput.send()`

### The map

```webidl
readonly attribute MIDIOutputMap outputs;   // on MIDIAccess
interface MIDIOutputMap { /* maplike<DOMString, MIDIOutput> */ };
```

`outputs` is a **read-only maplike** keyed by port `id`, exactly parallel to
`inputs : MIDIInputMap`. Iterating it (`for (const [, out] of access.outputs)`)
yields every currently-available output port — the same access pattern
`reconcile()` already uses for inputs.

### The port

```webidl
interface MIDIOutput : MIDIPort {
  undefined send(sequence<octet> data, optional DOMHighResTimeStamp timestamp = 0);
  undefined clear();
};
```

`MIDIOutput` **is a `MIDIPort`** and inherits the identity/lifecycle fields we
rely on for selection and liveness:

| field          | type                     | notes |
|----------------|--------------------------|-------|
| `id`           | `DOMString`              | unique per port; UA *SHOULD* keep it stable across app instances, but it is **not guaranteed stable across replugs** — same caveat as inputs (#2), so the name+manufacturer fallback still matters. |
| `name`         | `DOMString?`             | nullable |
| `manufacturer` | `DOMString?`             | nullable |
| `state`        | `"connected"\|"disconnected"` | a disconnected port can linger in the map — skip it, same as `reconcile()` does for inputs. |
| `connection`   | `"open"\|"closed"\|"pending"` | see [§3](#3-openclose-and-liveness). |
| `type`         | `"output"`               | always `output` here. |

### `send(data, timestamp?)`

- **`data`** is a `sequence<octet>` — a plain JS array (or typed array) of bytes,
  e.g. `output.send([0x90, 0x2d, 0x7f])` for Note-On note 45 velocity 127.
  Members are coerced to `uint8`.
- **`timestamp`** is a `DOMHighResTimeStamp` (ms, same clock as
  `performance.now()`). `0` (the default) / any past-or-present value means
  "send ASAP". We want immediate sends → **omit it**. Future timestamps let you
  schedule; irrelevant for LED-mirrors-state.
- **Ordering:** calls with equal timestamps are delivered in call order.
- **Return:** `undefined`. Fire-and-forget — no promise, no delivery
  confirmation. (Contrast the WS transport, which also fire-and-forgets after an
  `OPEN` check.)
- **`clear()`** drops queued-but-unsent data (only meaningful with future
  timestamps). Not needed for immediate LED sends.

### Validation / exceptions on `send()`

| condition | thrown |
|-----------|--------|
| `data` is not a valid MIDI byte sequence (bad/incomplete message) | `TypeError` |
| **Running status** bytes in `data` (status omitted, relying on prior status) | not allowed → `TypeError` |
| a **System Exclusive** message when sysex was not granted | `InvalidAccessError` |
| the port's device `state` is `"disconnected"` | `InvalidStateError` |

Implication: every `send()` must be a **complete, self-contained** MIDI message
with an explicit status byte, and we must **guard against sending to a
disconnected port** (wrap in the reconcile-driven bound set, and/or try/catch —
a mirror push firing during an unplug race shouldn't throw uncaught).

## 2. Hotplug parity — `onstatechange` covers outputs

`statechange` is a `MIDIPort`-level event: the UA fires `statechange` at the
`MIDIPort` *and* at the `MIDIAccess` whenever any port's `state` changes —
**inputs and outputs alike**, delivered as a `MIDIConnectionEvent` whose `.port`
identifies which port changed.

Concretely, #5 already installs exactly one handler:

```ts
midiAccess.onstatechange = () => this.reconcile();
```

That handler **already fires for output hotplug/unplug** too. So the output
reconcile is not a new event wiring — it is the *same* `reconcile()` doing a
second pass over `#access.outputs`. The shipped `reconcile()`:

1. unbinds everything it holds,
2. re-iterates the access map, skipping `state !== "connected"` and
   non-selected ports,
3. binds the survivors and calls `refreshStatus()`.

The output version is structurally identical, with two differences:

- **Binding an output is not setting a callback** (there is no
  `onmidimessage` equivalent) — it is *retaining the `MIDIOutput` reference* so
  later `send()`s have a target. So the "bound set" for outputs is just
  `Set<MIDIOutput>` we push to.
- **Optionally `open()`** the port first (see §3), which is async — so output
  reconcile has a promise edge the input reconcile doesn't. In practice
  `send()` **auto-opens** an implicitly-closed port, so an explicit `open()` is
  optional; call it only if we want `connection: "open"` to gate liveness.

## 3. `open()`/`close()` and liveness

```webidl
Promise<MIDIPort> open();
Promise<MIDIPort> close();
```

- A port starts `connection: "closed"`. **`send()` on a closed-but-connected
  port implicitly opens it** — so LED pushes work without an explicit `open()`.
- `open()` is worth calling if we want liveness (`active()`) to key off
  `connection === "open"` rather than merely "≥1 selected output present". The
  input transport defines `active()` as "≥1 device bound"; the simplest parity
  is **output `active()` = ≥1 selected output in the bound set**, ignoring
  `connection`. Good enough for the widget's live-dot.
- `close()` finishes pending immediate sends, drops future-scheduled data, sets
  `connection: "closed"`, fires `statechange`. Our `close()`/`detach()` path can
  just drop references and let GC/close happen; explicitly `close()`-ing bound
  outputs on `detach` is tidy but not required.

## 4. In/out port relationship

A single USB MIDI device (e.g. RodeCaster Pro II) exposes **two independent
ports**: a `MIDIInput` and a `MIDIOutput`, each with its **own distinct `id`**,
living in **separate maps** (`inputs` vs `outputs`). They typically **share the
same `name` and `manufacturer`** (the device/product string), but the spec does
*not* guarantee it, and multi-port interfaces can suffix port names
("Device MIDI 1", "Device DAW"). There is **no API link** back from an input to
"its" output — you correlate them yourself, by name/manufacturer.

This forces one design decision for the mapping/config work
([map "Not yet specified"](https://github.com/sigma/callctl/issues/16)):

**Option A — one selection covers both directions.** Reuse #5's
`midi.devices` (`MidiDevices = "all" | MidiDeviceRef[]`) for outputs too: for
each selected device, bind its input (as today) *and* find the matching output
by `matchesMidiDevice` on `name+manufacturer`. Simplest UX (user checks "Rode­Caster"
once, both directions light up), and `matchesMidiDevice` already does
name+mfr matching. Risk: a device whose in/out ports have **different names**
won't correlate, and "all" is unambiguous but selection-by-ref must fall back to
name+mfr because the *input's* stored `id` never equals the *output's* `id`.

**Option B — separate output selection.** Add `midi.outputDevices` alongside
`midi.devices`. Precise, handles asymmetric naming, but doubles the config
surface and the widget UI.

**Recommendation: Option A**, because (a) the physical mental model is
"one device", (b) `matchesMidiDevice`'s name+manufacturer fallback is *exactly*
the cross-port correlation tool, and (c) `TransportConfig.midi` was kept
extensible for the `mapping` home, not a second device list. The correlation
caveat (different in/out names) becomes a concrete thing the **hardware-capture
task** verifies for the RodeCaster: dump both ports' `name`s and confirm they
match. If they don't, revisit B. Whichever way, the **matcher and the
`MidiDeviceRef` shape are reused unchanged** — this is a selection-plumbing
decision, not a new identity model.

> Note the `MidiDeviceRef.id` stored from an **input** will only ever match the
> output via the name+manufacturer fallback (distinct ids). So Option A's output
> binding is *fallback-first* in practice — worth an explicit test mirroring
> #5's "falls back to name+manufacturer when the id has drifted".

## 5. Permissions & SysEx

- **Plain `requestMIDIAccess()`** (what #5 calls today) grants input + output of
  **non-SysEx** messages. Note-On, Note-Off, Control-Change, Program-Change all
  send fine with **no extra permission and no prompt** in current Chromium.
- **`requestMIDIAccess({ sysex: true })`** is required to *send or receive*
  System Exclusive (`0xF0 … 0xF7`) messages. Requesting it triggers a
  **permission prompt**; denial rejects with `NotAllowedError`. Sending a sysex
  message without the grant throws `InvalidAccessError`. `access.sysexEnabled`
  reports whether it was granted.
- Chromium also gates Web MIDI behind a **secure context** and a Permissions-Policy;
  our extension content-script context already satisfies this (input works today).

**What this means for LED feedback:** the open question is *how the RodeCaster
lights its pads*. Two families:

1. **Note-On / CC LED control** (Mackie Control / HUI convention, and most
   "smart pad" surfaces): the host sends `Note-On <padNote> <velocity>` where
   velocity encodes color/brightness, or a CC. **No SysEx → no `{sysex:true}` →
   no prompt.** This is the likely case and the happy path.
2. **SysEx LED control** (some devices expose per-pad RGB only via a vendor
   SysEx frame): requires `{sysex:true}`, a permission prompt on first use, and
   a decision about *when* to request it (lazily on enabling MIDI output, or up
   front).

**This is exactly the fact the hardware-capture task must nail down.** The
research can't settle it from the spec — it depends on the RodeCaster's MIDI
implementation. Recommendation: **default to plain `requestMIDIAccess()`** and
only escalate to `{sysex:true}` if capture proves the pads need it. Escalating
later is a one-line change plus a prompt; requesting sysex we don't need adds a
user-facing prompt for nothing.

## Open items this hands to downstream tickets

- **Transport-design ticket:** implement `send()`, add the output bound-set +
  `outputs` reconcile pass, decide the initial-LED-sync `onConnect`-equivalent
  (MIDI has no socket-open event — the natural trigger is *reconcile binding
  the first output*, i.e. call the state-push once an output becomes bound).
- **Mapping-model ticket:** Option A vs B for output selection; the byte-shape
  of an LED message (Note-On vs CC, value scheme) as config.
- **Hardware-capture task:** RodeCaster pad note/CC numbers, LED value scheme,
  in-vs-out port `name`s (for Option A correlation), and **whether LED control
  needs SysEx** (the one thing that changes the `requestMIDIAccess` call).
