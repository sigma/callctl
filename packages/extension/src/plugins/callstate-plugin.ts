import { message, SelectorKey, StateEvent } from "@callctl/protocol";
import type { Disposer } from "../disposer.js";
import { ControlsNotFoundError, HTMLModel } from "../meet/model.js";
import { type SelectorRegistry, selectors } from "../meet/selectors.js";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Optional read-only **join-detection** (§10). This plugin never drives Meet: it
 * watches the DOM and pushes a `callState` state event so the Stream Deck plugin
 * can dismiss the Next-Meeting late state the instant you actually join.
 *
 * "Joined" is proven by **two** conditions together:
 *   1. the Meet URL carries a valid meeting **code**, and
 *   2. the **"Leave call"** button is present ({@link SelectorKey.Leave}).
 *
 * The Leave button renders only once you are admitted and in the call, so
 * requiring it avoids false positives from the green room / admission lobby
 * (same `meet.google.com/xxx-xxxx-xxx` URL). When both hold, we emit the
 * provider-namespaced code (`gmeet:<code>`); otherwise we emit the event with no
 * `data` ("not in a call"). If Google renames the Leave aria-label, detection
 * silently stops and the plugin falls back to its grace timer — acceptable,
 * because that timer is the primary path (§10).
 *
 * Follows the {@link HandPlugin} template: a broad `MutationObserver` from
 * `document.documentElement` (Meet re-renders controls and can swap `<body>`),
 * additive change subscriptions, and a push on connect via {@link Transport}.
 */

/** Google Meet meeting code, e.g. `abc-def-ghi` — mirrors the plugin-side canonical form (§6.2). */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
/** Provider namespace on the emitted key (§10); the extension only detects Meet today. */
const MEET_PREFIX = "gmeet:";

export interface CallStateModel {
  /**
   * Subscribe to join/leave transitions. Additive (a `Set`, never a settable
   * field) for the same reason as {@link HandModel.onHandStateChange}:
   * `installHooks` runs once per transport, so a single field would let one
   * transport clobber another's pusher. Returns a {@link Disposer}.
   */
  onCallStateChange: (listener: () => void) => Disposer;
  /**
   * The join key right now: `gmeet:<code>` when the URL code is valid **and** the
   * Leave button is present, else `undefined` ("not in a call").
   */
  getCallState: () => string | undefined;
}

class HTMLCallStateModel implements CallStateModel {
  readonly #model: HTMLModel;
  readonly #selectors: SelectorRegistry;
  readonly #href: () => string;
  readonly #listeners = new Set<() => void>();
  #lastKey: string | undefined;
  #hasLast = false;
  #rescanQueued = false;

  constructor(
    model: HTMLModel,
    doc: Document = document,
    registry: SelectorRegistry = selectors,
    href: () => string = () => globalThis.location.href,
  ) {
    this.#model = model;
    this.#selectors = registry;
    this.#href = href;

    // Same broad watch as the hand model: Meet re-renders the toolbar rather
    // than mutating it in place, and the "Leave call" button appears/disappears
    // on join/leave. Watch childList + aria-label from documentElement (<html>
    // is never replaced) and re-derive the join key.
    const observer = new MutationObserver(() => this.#scheduleRescan());
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  }

  onCallStateChange(listener: () => void): Disposer {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getCallState(): string | undefined {
    const code = this.#urlCode();
    if (code === undefined) return undefined;
    // Require in-call proof: the Leave button is only present once admitted.
    if (this.#model.getElement(this.#selectors.get(SelectorKey.Leave)) === undefined) {
      return undefined;
    }
    return `${MEET_PREFIX}${code}`;
  }

  /** The valid Meet code in the current URL, or `undefined`. */
  #urlCode(): string | undefined {
    let url: URL;
    try {
      url = new URL(this.#href());
    } catch {
      return undefined;
    }
    if (url.host !== "meet.google.com") return undefined;
    const code = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    return MEET_CODE.test(code) ? code : undefined;
  }

  #scheduleRescan(): void {
    if (this.#rescanQueued) return;
    this.#rescanQueued = true;
    queueMicrotask(() => {
      this.#rescanQueued = false;
      this.#rescan();
    });
  }

  #rescan(): void {
    const key = this.getCallState();
    if (this.#hasLast && key === this.#lastKey) return;
    this.#hasLast = true;
    this.#lastKey = key;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

interface CallState {
  sendCallState: (t: Transport) => void;
  transmit: (t: Transport) => void;
}

class ModeledCallState implements CallState {
  readonly #model: CallStateModel;

  constructor(model: CallStateModel) {
    this.#model = model;
  }

  sendCallState(t: Transport): void {
    // `undefined` data ⇒ the event carries no `data` ("not in a call", §10).
    t.send(message(StateEvent.CallState, this.#model.getCallState()));
  }

  transmit(t: Transport): void {
    try {
      this.sendCallState(t);
    } catch (e) {
      // Expected at startup before Meet's controls are in the DOM.
      if (!(e instanceof ControlsNotFoundError)) {
        throw e;
      }
    }
  }
}

class CallStatePlugin implements MeetPlugin {
  readonly #model: HTMLCallStateModel;
  readonly #state: CallState;

  constructor() {
    this.#model = new HTMLCallStateModel(new HTMLModel());
    this.#state = new ModeledCallState(this.#model);
  }

  ID(): number {
    return 200;
  }

  installHooks(t: Transport): void {
    const state = this.#state;
    // Push on connect (§10). `onConnect` is a single settable field, and the
    // core plugin already owns it for the initial mic/camera transmit — chain
    // rather than clobber, so both fire regardless of install order.
    const prevOnConnect = t.onConnect;
    t.onConnect = () => {
      prevOnConnect();
      state.transmit(t);
    };
    // Push on every join/leave transition. Park the unsubscribe on the transport
    // so detaching it removes this pusher from the model rather than leaking it.
    t.onDetach(this.#model.onCallStateChange(() => state.sendCallState(t)));
  }

  installHandlers(_t: Transport): void {
    // Read-only signal: the plugin only pushes `callState`, it answers no
    // commands (the Stream Deck side never queries — it receives on connect).
  }
}

export function newCallStatePlugin(): MeetPlugin {
  console.log("loading call-state plugin");
  return new CallStatePlugin();
}

export { HTMLCallStateModel, ModeledCallState };
