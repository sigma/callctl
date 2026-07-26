import { Command, message, StateEvent, StateValue } from "@meetdeck/protocol";
import { type AriaElement, ControlsNotFoundError, HTMLModel, UIElement } from "../meet/model.js";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Raise/lower/toggle hand plus hand-state push-back. Faithful port of the
 * legacy `google_hand_plugin.ts` (was gated behind Go's `!public` build tag).
 * Wire strings come from `@meetdeck/protocol`.
 */

export interface HandModel {
  onHandStateChange: () => void;
  getHandState: () => boolean;
  getElement: (label: string) => UIElement | undefined;
}

class HTMLHandModel implements HandModel {
  readonly #model: HTMLModel;
  readonly #observer: MutationObserver;

  constructor(model: HTMLModel, doc: Document = document) {
    this.#model = model;

    const handleHandStateChange = (mutationsList: MutationRecord[]): void => {
      for (const mutation of mutationsList) {
        if (mutation.type !== "attributes") {
          continue;
        }
        const target = mutation.target as AriaElement;
        if (
          (target.ariaLabel?.startsWith("Raise hand") ?? false) ||
          (target.ariaLabel?.startsWith("Lower hand") ?? false)
        ) {
          // Call dynamically so HandPlugin's reassignment takes effect (the
          // legacy code captured the empty default into a const — see the same
          // fix in HTMLModel).
          this.onHandStateChange();
        }
      }
    };

    this.#observer = new MutationObserver(handleHandStateChange);
    this.#observer.observe(doc.body, {
      attributes: true,
      attributeFilter: ["aria-label"],
      attributeOldValue: true,
      subtree: true,
    });
  }

  onHandStateChange: () => void = () => {};

  getHandState(): boolean {
    const e = new UIElement(this.#model.getAriaElement("hand"));
    return !e.pressed();
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

  constructor(m: HandModel) {
    this.#model = m;
  }

  raiseHand(): void {
    this.#model.getElement("Raise hand")?.click();
  }

  lowerHand(): void {
    this.#model.getElement("Lower hand")?.click();
  }

  toggleHand(): void {
    const raise = this.#model.getElement("Raise hand");
    const button = raise != null ? raise : this.#model.getElement("Lower hand");
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
    this.#model.onHandStateChange = () => {
      state.sendHandState(t);
    };
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
