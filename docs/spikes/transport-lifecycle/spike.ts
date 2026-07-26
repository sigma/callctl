// SPIKE — throwaway. Ticket: "Live transport lifecycle: dynamic
// enable/disable/reconfigure" (github.com/sigma/callctl#3, map #1).
//
// Not wired into the build. It exists to make the lifecycle mechanism concrete
// enough to react to. It leans on the SHAPES of the real types
// (packages/extension/src/transport/*, plugins/plugin.ts, meet/model.ts) but
// is standalone so it can't perturb production. Types are trimmed to the parts
// the lifecycle question actually touches.
//
// The question (verbatim from the ticket): how does a transport get enabled,
// disabled, or reconfigured AT RUNTIME with no tab reload?
//
// The whole spike turns on one missing capability in today's code: an
// *installation* is fire-and-forget, so there is nothing to undo. Give every
// install step a disposer and route those disposers to the transport that owns
// them, and enable/disable/reconfigure all fall out of one add/remove path.

// ----------------------------------------------------------------------------
// 0. The primitive today's code is missing: a disposer.
// ----------------------------------------------------------------------------

/** Undo one thing. Returned by every subscribe/install call below. */
type Disposer = () => void;

// Trimmed stand-ins for the real wire/plugin types.
type Message = { event?: string; data?: string };

// ----------------------------------------------------------------------------
// 1. Model change-subscriptions must return their unsubscribe.
// ----------------------------------------------------------------------------
//
// Today `onMuteStateChange(listener)` returns void — additive (a Set) but
// NOT removable (see meet/model.ts:94 and the CLAUDE.md gotcha). Removability
// is the only change: still a Set, still additive, but hand back the remover.
// This is the load-bearing edit — without it, disabling a transport leaves a
// dead pusher wired into the model forever.

enum InputDevice {
  MIC = 0,
  CAMERA = 1,
}

interface Model {
  /** Additive AND removable. The returned Disposer removes just this listener. */
  onMuteStateChange(listener: (dev: InputDevice) => void): Disposer;
}

class SpikeModel implements Model {
  readonly #muteListeners = new Set<(dev: InputDevice) => void>();

  onMuteStateChange(listener: (dev: InputDevice) => void): Disposer {
    this.#muteListeners.add(listener);
    return () => this.#muteListeners.delete(listener); // <-- the whole point
  }

  // (test hook) fire a transition
  emitMute(dev: InputDevice): void {
    for (const l of this.#muteListeners) l(dev);
  }
}

// ----------------------------------------------------------------------------
// 2. A transport owns "everything to undo when I go away".
// ----------------------------------------------------------------------------
//
// The transport is the unit being added/removed, so it should own its own
// teardown. `onDetach(d)` is a disposer *sink*: anything installed against the
// transport parks its cleanup here. `detach()` runs them all, then closes the
// pipe. Handlers already live in a per-transport map, so clearing them is free.

interface LiveTransport {
  onConnect: () => void;
  send(message: Message): void;
  handle(op: string, h: (msg: Message) => void): void;

  /** Park a disposer to be run on detach. Returned by every install step. */
  onDetach(d: Disposer): void;

  /** Reversible teardown: run parked disposers, drop handlers, close pipe. */
  detach(): void;
}

/** Base that gives any transport the disposer-sink + handler bookkeeping. */
abstract class BaseTransport implements LiveTransport {
  onConnect: () => void = () => {};
  protected readonly handlers = new Map<string, (msg: Message) => void>();
  readonly #disposers = new Set<Disposer>();

  handle(op: string, h: (msg: Message) => void): void {
    this.handlers.set(op, h);
    // Registering a handler is itself an installation → it too is undoable.
    this.onDetach(() => this.handlers.delete(op));
  }

  onDetach(d: Disposer): void {
    this.#disposers.add(d);
  }

  detach(): void {
    for (const d of this.#disposers) d();
    this.#disposers.clear();
    this.handlers.clear();
    this.close();
  }

  abstract send(message: Message): void;
  /** Transport-specific pipe teardown (close socket, unbind MIDI, …). */
  protected abstract close(): void;
}

// ----------------------------------------------------------------------------
// 3. The websocket transport, with an IN-PLACE live port switch (Q2).
// ----------------------------------------------------------------------------
//
// A port change is NOT disable+enable — that would tear down and re-install
// every plugin for a mere reconnection. Instead `retarget(port)` redials the
// socket on a new port while keeping all installed hooks/handlers/disposers
// intact. The reconnect is transparent: only THIS ws blips; the Meet tab /
// call is untouched because the content script never reloads. This is the
// whole of the dev-bridge port switch (#6): registry.retarget("ws", devPort).
//
// `port` is now mutable state, not a readonly ctor arg — the transport instance
// outlives any single port.

class WSTransport extends BaseTransport {
  #ws: FakeSocket | null = null;
  #port: number;
  #shut = false;

  constructor(port: number) {
    super();
    this.#port = port;
    this.#connect();
  }

  #connect(): void {
    const ws = new FakeSocket(this.#port);
    this.#ws = ws;
    ws.onopen = () => this.onConnect(); // re-push state → LEDs start right
    ws.onclose = () => {
      this.#ws = null;
      if (!this.#shut) setTimeout(() => this.#connect(), 2000);
    };
    ws.onmessage = (raw) => {
      const msg = JSON.parse(raw) as Message;
      this.handlers.get(msg.event ?? "")?.(msg);
    };
  }

  /** Live port switch: redial without disturbing installed plugins (Q2). */
  retarget(port: number): void {
    if (port === this.#port) return;
    this.#port = port;
    this.#ws?.close(); // onclose reconnects to the new #port; #shut still false
  }

  send(message: Message): void {
    if (this.#ws?.readyState === "open") this.#ws.send(JSON.stringify(message));
  }

  protected close(): void {
    this.#shut = true; // stop the reconnect loop; detach() is permanent for this instance
    this.#ws?.close();
  }
}

// ----------------------------------------------------------------------------
// 4. Plugins install via the transport; every step parks its disposer.
// ----------------------------------------------------------------------------
//
// The ONLY plugin-facing change vs today: installHooks/installHandlers take
// the same transport but now route cleanup through `t.onDetach`. `handle()`
// already self-disposes (see BaseTransport), so installHandlers is untouched
// in spirit — the change is concentrated in installHooks, where the model
// subscription's returned disposer gets parked.

interface MeetPlugin {
  ID(): number;
  installHooks(t: LiveTransport): void;
  installHandlers(t: LiveTransport): void;
}

class CorePluginSpike implements MeetPlugin {
  constructor(readonly model: SpikeModel) {}
  ID(): number {
    return 1;
  }

  installHooks(t: LiveTransport): void {
    t.onConnect = () => t.send({ event: "state", data: "snapshot" });
    // BEFORE: this.model.onMuteStateChange(dev => ...)   // leaked forever
    // AFTER:  park the unsubscribe on the transport.
    t.onDetach(this.model.onMuteStateChange((dev) => t.send({ event: "mute", data: String(dev) })));
  }

  installHandlers(t: LiveTransport): void {
    t.handle("toggleMic", () => this.model.emitMute(InputDevice.MIC));
  }
}

// ----------------------------------------------------------------------------
// 5. The registry: replaces the static MultiProtocol([...]) array.
// ----------------------------------------------------------------------------
//
// Keyed by a stable string id ("ws", "midi"). enable() builds a transport,
// installs every plugin against it, records it. disable() detaches it (which
// runs all parked disposers → model listeners gone, handlers gone, socket
// closed). retarget() re-parameterizes a LIVE transport WITHOUT touching its
// installed plugins (Q2). That's the whole lifecycle; the widget and dev-bridge
// switch are just callers.

/**
 * A live transport that can be re-parameterized in place — no teardown, no
 * plugin re-install. `Config` is per-transport: WS = new port, MIDI (#5) = the
 * checked device set. The registry stays generic over it.
 */
interface Retargetable<Config> {
  retarget(config: Config): void;
}

class TransportRegistry {
  readonly #live = new Map<string, LiveTransport>();

  constructor(readonly plugins: MeetPlugin[]) {}

  enable(id: string, factory: () => LiveTransport): void {
    if (this.#live.has(id)) return; // idempotent
    const t = factory();
    for (const p of this.plugins) {
      p.installHooks(t);
      p.installHandlers(t);
    }
    this.#live.set(id, t);
  }

  disable(id: string): void {
    const t = this.#live.get(id);
    if (!t) return;
    t.detach(); // <-- one call undoes everything installed on it
    this.#live.delete(id);
  }

  /**
   * Live re-parameterize (Q2): the running transport redials/rebinds itself and
   * KEEPS every installed hook + handler. No disable/enable, no plugin churn.
   * No-op if the slot isn't enabled or its transport isn't Retargetable.
   */
  retarget<Config>(id: string, config: Config): void {
    const t = this.#live.get(id) as (LiveTransport & Partial<Retargetable<Config>>) | undefined;
    t?.retarget?.(config);
  }

  isEnabled(id: string): boolean {
    return this.#live.has(id);
  }
}

// ----------------------------------------------------------------------------
// 6. How the widget (T4) and its callers drive it — the payoff.
// ----------------------------------------------------------------------------

function demo(): void {
  const model = new SpikeModel();
  const registry = new TransportRegistry([new CorePluginSpike(model)]);

  // Widget: Stream Deck toggle ON
  registry.enable("ws", () => new WSTransport(2395));

  // Widget: dev-bridge ON → same live transport redials the dev-bridge port.
  // Plugins are NOT re-installed (Q2); only the socket blips. Transparent.
  registry.retarget<number>("ws", 2396);

  // Widget: Stream Deck toggle OFF → detach; model listener is truly gone,
  // so a later mute change pushes to NOBODY (no stale/duplicate pusher).
  registry.disable("ws");
  model.emitMute(InputDevice.MIC); // no-op now — the leak is fixed

  console.log("ws enabled:", registry.isEnabled("ws")); // false
}

// ----------------------------------------------------------------------------
// Minimal fake socket so the spike is self-contained.
// ----------------------------------------------------------------------------
class FakeSocket {
  readyState: "connecting" | "open" | "closed" = "connecting";
  onopen: () => void = () => {};
  onclose: () => void = () => {};
  onmessage: (raw: string) => void = () => {};
  constructor(readonly port: number) {
    this.readyState = "open";
    this.onopen();
  }
  send(_raw: string): void {}
  close(): void {
    this.readyState = "closed";
    this.onclose();
  }
}

export { TransportRegistry, WSTransport, CorePluginSpike, SpikeModel, demo };
