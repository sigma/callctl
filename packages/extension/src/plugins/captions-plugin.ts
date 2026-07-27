import { Command, message, SelectorKey, StateEvent, StateValue } from "@callctl/protocol";
import type { Disposer } from "../disposer.js";
import { ControlsNotFoundError, HTMLModel, type UIElement } from "../meet/model.js";
import { type SelectorRegistry, selectors } from "../meet/selectors.js";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Enable/disable/toggle captions plus captions-state push-back. Modeled on
 * `hand-plugin.ts`, not the mic model: Meet's captions button is label-keyed
 * ("Turn on captions" when off, "Turn off captions" when on) with no
 * `aria-pressed`, exactly like the hand button. Wire strings come from
 * `@callctl/protocol`.
 */

export interface CaptionsModel {
  /**
   * Subscribe to captions on/off transitions. Additive (not a settable field)
   * for the same reason as {@link HandModel.onHandStateChange}: `installHooks`
   * runs once per transport, and a single field let the no-op MIDI transport
   * clobber the websocket's push. Returns a {@link Disposer} that removes just
   * this listener.
   */
  onCaptionsStateChange: (listener: () => void) => Disposer;
  getCaptionsState: () => boolean;
  getElement: (label: string) => UIElement | undefined;
}

class HTMLCaptionsModel implements CaptionsModel {
  readonly #model: HTMLModel;
  readonly #selectors: SelectorRegistry;
  readonly #captionsListeners = new Set<() => void>();
  #lastOn: boolean | undefined;
  #rescanQueued = false;

  constructor(model: HTMLModel, doc: Document = document, registry: SelectorRegistry = selectors) {
    this.#model = model;
    this.#selectors = registry;

    // Same shape as the hand observer: watch broadly (childList + aria-label)
    // from documentElement and re-derive the captions state, since Meet
    // re-renders the toolbar button rather than mutating it in place. The button
    // reads "Turn on captions …" when off and "Turn off captions …" when on;
    // `aria-pressed` is never set, so we key off the label, not the pressed
    // state.
    const observer = new MutationObserver(() => this.#scheduleRescan());
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  }

  onCaptionsStateChange(listener: () => void): Disposer {
    this.#captionsListeners.add(listener);
    return () => this.#captionsListeners.delete(listener);
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
    const on = this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOn)) !== undefined;
    const off = this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOff)) !== undefined;
    if (!on && !off) {
      return; // the toolbar captions button isn't present right now — don't guess
    }
    const enabled = off;
    if (this.#lastOn !== enabled) {
      this.#lastOn = enabled;
      for (const listener of this.#captionsListeners) {
        listener();
      }
    }
  }

  /**
   * Whether captions are on. Keyed off the toolbar button's label: a "Turn off
   * captions" button is only present while captions are enabled.
   */
  getCaptionsState(): boolean {
    return this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOff)) !== undefined;
  }

  getElement(label: string): UIElement | undefined {
    return this.#model.getElement(label);
  }
}

interface CaptionsState {
  sendCaptionsState: (t: Transport) => void;
  transmit: (t: Transport) => void;
}

class ModeledCaptionsState implements CaptionsState {
  readonly #model: CaptionsModel;

  constructor(model: CaptionsModel) {
    this.#model = model;
  }

  sendCaptionsState(t: Transport): void {
    const on = this.#model.getCaptionsState();
    t.send(message(StateEvent.CaptionsState, on ? StateValue.CaptionsOn : StateValue.CaptionsOff));
  }

  transmit(t: Transport): void {
    try {
      this.sendCaptionsState(t);
    } catch (e) {
      // Expected at startup before Meet's controls are in the DOM.
      if (!(e instanceof ControlsNotFoundError)) {
        throw e;
      }
    }
  }
}

interface CaptionsAPI {
  enableCaptions: () => void;
  disableCaptions: () => void;
  toggleCaptions: () => void;
}

export class ModeledCaptionsAPI implements CaptionsAPI {
  readonly #model: CaptionsModel;
  readonly #selectors: SelectorRegistry;

  constructor(m: CaptionsModel, registry: SelectorRegistry = selectors) {
    this.#model = m;
    this.#selectors = registry;
  }

  enableCaptions(): void {
    this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOn))?.click();
  }

  disableCaptions(): void {
    this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOff))?.click();
  }

  toggleCaptions(): void {
    const on = this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOn));
    const button =
      on != null ? on : this.#model.getElement(this.#selectors.get(SelectorKey.CaptionsOff));
    button?.click();
  }
}

class CaptionsPlugin implements MeetPlugin {
  readonly #model: HTMLCaptionsModel;
  readonly #api: CaptionsAPI;
  readonly #state: CaptionsState;

  constructor() {
    this.#model = new HTMLCaptionsModel(new HTMLModel());
    this.#api = new ModeledCaptionsAPI(this.#model);
    this.#state = new ModeledCaptionsState(this.#model);
  }

  ID(): number {
    return 102;
  }

  installHooks(t: Transport): void {
    const state = this.#state;
    // Park the unsubscribe on the transport, so detaching it removes this
    // captions-state pusher from the model rather than leaking it.
    t.onDetach(this.#model.onCaptionsStateChange(() => state.sendCaptionsState(t)));
  }

  installHandlers(t: Transport): void {
    const api = this.#api;
    const state = this.#state;
    const pusher = (f: () => void) => () => f();

    const handlers = new Map<string, () => void>([
      [Command.EnableCaptions, pusher(() => api.enableCaptions())],
      [Command.DisableCaptions, pusher(() => api.disableCaptions())],
      [Command.ToggleCaptions, pusher(() => api.toggleCaptions())],
      [Command.GetCaptionsState, () => state.sendCaptionsState(t)],
    ]);

    for (const [event, handler] of handlers) {
      t.handle(event, handler);
    }
  }
}

export function newCaptionsPlugin(): MeetPlugin {
  console.log("loading google captions plugin");
  return new CaptionsPlugin();
}
