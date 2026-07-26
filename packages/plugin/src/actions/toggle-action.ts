import { SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import type { MeetRemote } from "../remote/meet-remote.js";

/**
 * Configuration for a three-visual toggle action.
 * `led()` reads the remote's on/off state; `toggle()` flips it; `ask()`
 * requests a fresh state push from Meet.
 */
export interface ToggleSpec {
  uuid: string;
  toggle: () => void;
  ask: () => void;
  led: () => boolean;
  /** Manifest-relative image path shown while the extension is disconnected. */
  disconnectedImage: string;
}

/**
 * A stateful toggle (mic / camera / hand). Mirrors the Go `toggleTrigger` +
 * `handleRemoteState`: three visuals — connected-on, connected-off, and
 * disconnected.
 *
 * The manifest declares only the two connected states (SDK `setState` is 0|1);
 * the disconnected visual is applied at runtime via `setImage()`, since there
 * is no third manifest state. State index 0 = on, 1 = off.
 */
export class ToggleAction extends SingletonAction {
  readonly #spec: ToggleSpec;
  readonly #remote: MeetRemote;

  constructor(spec: ToggleSpec, remote: MeetRemote) {
    super();
    (this as { manifestId: string }).manifestId = spec.uuid;
    this.#spec = spec;
    this.#remote = remote;

    // Repaint whenever the remote's connection or Meet state changes.
    remote.onStateChange(() => this.#refresh());
  }

  /** On appear, ask Meet for the current state and paint from what we know. */
  override onWillAppear(_ev: WillAppearEvent): void {
    if (this.#remote.connected) {
      this.#spec.ask();
    }
    this.#refresh();
  }

  override onKeyDown(): void {
    // While disconnected the button is inert — there is nobody to toggle.
    if (!this.#remote.connected) {
      return;
    }
    this.#spec.toggle();
  }

  #refresh(): void {
    for (const action of this.actions) {
      if (!action.isKey()) {
        continue;
      }
      if (!this.#remote.connected) {
        void action.setImage(this.#spec.disconnectedImage);
        continue;
      }
      // Clear any disconnected override, then select the on/off manifest state.
      void action.setImage();
      void action.setState(this.#spec.led() ? 0 : 1);
    }
  }
}
