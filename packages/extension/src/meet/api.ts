import { message, StateEvent, StateValue } from "@meetdeck/protocol";
import type { Transport } from "../transport/transport.js";
import { ControlsNotFoundError, InputDevice, type Model } from "./model.js";

/**
 * The Meet-driving API layered over the {@link Model}. Faithful port of the
 * legacy `api.ts`, with the hand-written wire strings (`micState`, `muted`, …)
 * replaced by `@meetdeck/protocol` constants so the extension and plugin can
 * never drift.
 */

export interface State {
  sendMuteState: (t: Transport, dev: InputDevice) => void;
  transmit: (t: Transport) => void;
}

export class ModeledState implements State {
  readonly #model: Model;

  constructor(model: Model) {
    this.#model = model;
  }

  sendMuteState(t: Transport, dev: InputDevice): void {
    const muted = this.#model.getMuteState(dev);
    let event: string;
    if (dev === InputDevice.CAMERA) {
      event = StateEvent.CameraState;
    } else if (dev === InputDevice.MIC) {
      event = StateEvent.MicState;
    } else {
      throw new Error("Unknown input device");
    }

    t.send(message(event, muted ? StateValue.Muted : StateValue.Unmuted));
  }

  transmit(t: Transport): void {
    try {
      this.sendMuteState(t, InputDevice.MIC);
      this.sendMuteState(t, InputDevice.CAMERA);
    } catch (e) {
      // Expected at startup before Meet's controls are in the DOM.
      if (!(e instanceof ControlsNotFoundError)) {
        throw e;
      }
    }
  }
}

export interface API {
  state: () => State;
  toggleMute: (dev: InputDevice) => void;
  setMuteState: (dev: InputDevice, muted: boolean) => void;
  leaveCall: () => void;
  toggleParticipants: () => void;
  toggleChat: () => void;
}

export class ModeledAPI implements API {
  readonly #model: Model;
  readonly #state: ModeledState;

  constructor(m: Model) {
    this.#model = m;
    this.#state = new ModeledState(this.#model);
  }

  state(): ModeledState {
    return this.#state;
  }

  toggleMute(dev: InputDevice): void {
    this.#model.getMuteElement(dev)?.click();
  }

  setMuteState(dev: InputDevice, muted: boolean): void {
    const button = this.#model.getMuteElement(dev);
    if (button?.muted() !== muted) {
      button?.click();
    }
  }

  leaveCall(): void {
    this.#model.getElement("Leave call")?.click();
  }

  toggleParticipants(): void {
    // Meet renamed this control: it is now the hover-tray "People" button, whose
    // accessible name comes via aria-labelledby (see HTMLModel.#accessibleName).
    this.#model.getElement("People")?.click();
  }

  toggleChat(): void {
    this.#model.getElement("Chat with everyone")?.click();
  }
}
