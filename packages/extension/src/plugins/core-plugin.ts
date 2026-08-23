import { Command } from "@callctl/protocol";
import type { MidiAddressable, SurfacePlugin } from "../core/plugin.js";
import type { Transport } from "../core/transport/transport.js";
import { type API, ModeledAPI } from "../meet/api.js";
import { HTMLModel, InputDevice, type Model } from "../meet/model.js";

/**
 * The always-on plugin: mic + camera (mute/unmute/toggle/query), leave call,
 * and the participants/chat panels. Faithful port of the legacy `CorePlugin`,
 * with command names sourced from `@callctl/protocol`.
 */
class CorePlugin implements SurfacePlugin, MidiAddressable {
  readonly #model: Model;
  readonly #api: API;

  constructor() {
    this.#model = new HTMLModel();
    this.#api = new ModeledAPI(this.#model);
  }

  ID(): string {
    return "core";
  }

  midiCC(): number {
    return 1;
  }

  installHooks(t: Transport): void {
    const state = this.#api.state();
    // On (re)connect, push the current mic/camera state so the LEDs start right.
    t.onConnect = () => {
      state.transmit(t);
    };
    // And push again whenever Meet's mute state changes under us. Park the
    // unsubscribe on the transport so disabling it tears this pusher back out of
    // the model (else a disabled transport keeps a dead listener wired in).
    t.onDetach(this.#model.onMuteStateChange((dev) => state.sendMuteState(t, dev)));
  }

  installHandlers(t: Transport): void {
    const api = this.#api;

    const muter = (dev: InputDevice, muted: boolean) => () => api.setMuteState(dev, muted);
    const sender = (dev: InputDevice) => () => api.state().sendMuteState(t, dev);
    const toggler = (dev: InputDevice) => () => api.toggleMute(dev);
    const pusher = (f: () => void) => () => f();

    const handlers = new Map<string, () => void>([
      [Command.ToggleMic, toggler(InputDevice.MIC)],
      [Command.ToggleCamera, toggler(InputDevice.CAMERA)],
      [Command.LeaveCall, pusher(() => api.leaveCall())],
      [Command.ToggleParticipants, pusher(() => api.toggleParticipants())],
      [Command.ToggleChat, pusher(() => api.toggleChat())],

      [Command.MuteMic, muter(InputDevice.MIC, true)],
      [Command.UnmuteMic, muter(InputDevice.MIC, false)],
      [Command.GetMicState, sender(InputDevice.MIC)],

      [Command.DisableCamera, muter(InputDevice.CAMERA, true)],
      [Command.EnableCamera, muter(InputDevice.CAMERA, false)],
      [Command.GetCameraState, sender(InputDevice.CAMERA)],
    ]);

    for (const [event, handler] of handlers) {
      t.handle(event, handler);
    }
  }
}

export function newCorePlugin(): SurfacePlugin {
  console.log("loading core plugin");
  return new CorePlugin();
}
