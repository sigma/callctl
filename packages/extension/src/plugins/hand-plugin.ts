import { Command, message, SelectorKey, StateEvent, StateValue } from "@meetdeck/protocol";
import { ControlsNotFoundError, HTMLModel, type UIElement } from "../meet/model.js";
import { type SelectorRegistry, selectors } from "../meet/selectors.js";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Raise/lower/toggle hand plus hand-state push-back. Faithful port of the
 * legacy `google_hand_plugin.ts` (was gated behind Go's `!public` build tag).
 * Wire strings come from `@meetdeck/protocol`.
 */

export interface HandModel {
  /**
   * Subscribe to hand raise/lower transitions. Additive (not a settable field)
   * for the same reason as {@link Model.onMuteStateChange}: `installHooks` runs
   * once per transport, and a single field let the no-op MIDI transport clobber
   * the websocket's push.
   */
  onHandStateChange: (listener: () => void) => void;
  getHandState: () => boolean;
  getElement: (label: string) => UIElement | undefined;
}

class HTMLHandModel implements HandModel {
  readonly #model: HTMLModel;
  readonly #selectors: SelectorRegistry;
  readonly #handListeners = new Set<() => void>();
  #lastLowered: boolean | undefined;
  #rescanQueued = false;

  constructor(model: HTMLModel, doc: Document = document, registry: SelectorRegistry = selectors) {
    this.#model = model;
    this.#selectors = registry;

    // Same shape as HTMLModel's mute observer: watch broadly (childList +
    // aria-label) from documentElement and re-derive the hand state, since Meet
    // re-renders the toolbar button rather than mutating it in place. The button
    // reads "Raise hand …" when lowered and "Lower hand …" when raised;
    // `aria-pressed` is never set, so we key off the label, not the pressed
    // state (which always looked "lowered").
    const observer = new MutationObserver(() => this.#scheduleRescan());
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  }

  onHandStateChange(listener: () => void): void {
    this.#handListeners.add(listener);
  }

  #scheduleRescan(): void {
    if (this.#rescanQueued) {
      return;
    }
    this.#rescanQueued = true;
    queueMicrotask(() => {
      this.#rescanQueued = false;
      this.#rescan();
    });
  }

  #rescan(): void {
    const raise = this.#model.getElement(this.#selectors.get(SelectorKey.HandRaise)) !== undefined;
    const lower = this.#model.getElement(this.#selectors.get(SelectorKey.HandLower)) !== undefined;
    if (!raise && !lower) {
      return; // the toolbar hand button isn't present right now — don't guess
    }
    const lowered = !lower;
    if (this.#lastLowered !== lowered) {
      this.#lastLowered = lowered;
      for (const listener of this.#handListeners) {
        listener();
      }
    }
  }

  /**
   * Whether the hand is lowered. Keyed off the toolbar button's label: a
   * "Lower hand" button is only present while the hand is raised. (The
   * host-only "Lower all hands" / "Lower <name>'s hand" controls don't contain
   * the substring "Lower hand", so they don't confuse this.)
   */
  getHandState(): boolean {
    return this.#model.getElement(this.#selectors.get(SelectorKey.HandLower)) === undefined;
  }

  getElement(label: string): UIElement | undefined {
    return this.#model.getElement(label);
  }
}

interface HandState {
  sendHandState: (t: Transport) => void;
  transmit: (t: Transport) => void;
}

class ModeledHandState implements HandState {
  readonly #model: HandModel;

  constructor(model: HandModel) {
    this.#model = model;
  }

  sendHandState(t: Transport): void {
    const lowered = this.#model.getHandState();
    t.send(message(StateEvent.HandState, lowered ? StateValue.Lowered : StateValue.Raised));
  }

  transmit(t: Transport): void {
    try {
      this.sendHandState(t);
    } catch (e) {
      // Expected at startup before Meet's controls are in the DOM.
      if (!(e instanceof ControlsNotFoundError)) {
        throw e;
      }
    }
  }
}

interface HandAPI {
  raiseHand: () => void;
  lowerHand: () => void;
  toggleHand: () => void;
}

export class ModeledHandAPI implements HandAPI {
  readonly #model: HandModel;
  readonly #selectors: SelectorRegistry;

  constructor(m: HandModel, registry: SelectorRegistry = selectors) {
    this.#model = m;
    this.#selectors = registry;
  }

  raiseHand(): void {
    this.#model.getElement(this.#selectors.get(SelectorKey.HandRaise))?.click();
  }

  lowerHand(): void {
    this.#model.getElement(this.#selectors.get(SelectorKey.HandLower))?.click();
  }

  toggleHand(): void {
    const raise = this.#model.getElement(this.#selectors.get(SelectorKey.HandRaise));
    const button =
      raise != null ? raise : this.#model.getElement(this.#selectors.get(SelectorKey.HandLower));
    button?.click();
  }
}

class HandPlugin implements MeetPlugin {
  readonly #model: HTMLHandModel;
  readonly #api: HandAPI;
  readonly #state: HandState;

  constructor() {
    this.#model = new HTMLHandModel(new HTMLModel());
    this.#api = new ModeledHandAPI(this.#model);
    this.#state = new ModeledHandState(this.#model);
  }

  ID(): number {
    return 100;
  }

  installHooks(t: Transport): void {
    const state = this.#state;
    this.#model.onHandStateChange(() => state.sendHandState(t));
  }

  installHandlers(t: Transport): void {
    const api = this.#api;
    const state = this.#state;
    const pusher = (f: () => void) => () => f();

    const handlers = new Map<string, () => void>([
      [Command.LowerHand, pusher(() => api.lowerHand())],
      [Command.RaiseHand, pusher(() => api.raiseHand())],
      [Command.ToggleHand, pusher(() => api.toggleHand())],
      [Command.GetHandState, () => state.sendHandState(t)],
    ]);

    for (const [event, handler] of handlers) {
      t.handle(event, handler);
    }
  }
}

export function newHandPlugin(): MeetPlugin {
  console.log("loading google hand plugin");
  return new HandPlugin();
}
