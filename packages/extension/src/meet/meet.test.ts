import { afterEach, describe, expect, test, vi } from "vitest";
import type { Message } from "../transport/transport.js";
import { ModeledAPI, ModeledState } from "./api.js";
import { HTMLModel, InputDevice } from "./model.js";

/**
 * DOM-level tests for the Meet model/API under jsdom. These pin the selector
 * contract (aria-label / data-is-muted) the whole port hinges on, and prove the
 * push-back fix: a DOM-driven mute change must actually reach `onMuteStateChange`
 * (the legacy code captured the empty default into a const and dropped it).
 */

/**
 * Build a Meet-like control button. We set the `aria-label` attribute (for the
 * `[aria-label]` / `[data-is-muted]` selectors) *and* shadow the ARIA
 * reflection property the model reads, so the test doesn't depend on jsdom's
 * ARIA-reflection support.
 */
function control(label: string, opts: { muted?: boolean; pressed?: boolean } = {}): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", label);
  Object.defineProperty(el, "ariaLabel", { value: label, configurable: true });
  if (opts.muted !== undefined) {
    el.setAttribute("data-is-muted", String(opts.muted));
  }
  if (opts.pressed !== undefined) {
    el.setAttribute("aria-pressed", String(opts.pressed));
    Object.defineProperty(el, "ariaPressed", { value: String(opts.pressed), configurable: true });
  }
  el.click = vi.fn();
  document.body.appendChild(el);
  return el;
}

function collector(): { transport: { send: (m: Message) => void }; sent: Message[] } {
  const sent: Message[] = [];
  return { transport: { send: (m) => sent.push(m) }, sent };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("HTMLModel", () => {
  test("locates a mute button by device substring and reads its state", () => {
    control("Turn off microphone", { muted: false });
    const model = new HTMLModel();
    expect(model.getMuteState(InputDevice.MIC)).toBe(false);
  });

  test("getElement matches a label substring", () => {
    const leave = control("Leave call");
    const model = new HTMLModel();
    model.getElement("Leave call")?.click();
    expect(leave.click).toHaveBeenCalledOnce();
  });
});

describe("ModeledAPI", () => {
  test("toggleMute clicks the device's mute button", () => {
    const mic = control("Turn off microphone", { muted: false });
    const api = new ModeledAPI(new HTMLModel());
    api.toggleMute(InputDevice.MIC);
    expect(mic.click).toHaveBeenCalledOnce();
  });

  test("setMuteState clicks only when the current state differs", () => {
    const mic = control("Turn off microphone", { muted: false });
    const api = new ModeledAPI(new HTMLModel());

    api.setMuteState(InputDevice.MIC, false); // already unmuted → no click
    expect(mic.click).not.toHaveBeenCalled();

    api.setMuteState(InputDevice.MIC, true); // needs to change → click
    expect(mic.click).toHaveBeenCalledOnce();
  });

  test("leave/participants/chat click their respective controls", () => {
    const leave = control("Leave call");
    const people = control("Show everyone");
    const chat = control("Chat with everyone");
    const api = new ModeledAPI(new HTMLModel());

    api.leaveCall();
    api.toggleParticipants();
    api.toggleChat();

    expect(leave.click).toHaveBeenCalledOnce();
    expect(people.click).toHaveBeenCalledOnce();
    expect(chat.click).toHaveBeenCalledOnce();
  });
});

describe("ModeledState", () => {
  test("sends the right wire event + value per device", () => {
    control("Turn off microphone", { muted: true });
    control("Turn off camera", { muted: false });
    const model = new HTMLModel();
    const state = new ModeledState(model);
    const { transport, sent } = collector();

    state.sendMuteState(transport as never, InputDevice.MIC);
    state.sendMuteState(transport as never, InputDevice.CAMERA);

    expect(sent).toEqual([
      { event: "micState", data: "muted" },
      { event: "cameraState", data: "unmuted" },
    ]);
  });
});

describe("mute-state push-back (regression: reassigned onMuteStateChange must fire)", () => {
  test("a DOM data-is-muted change reaches the reassigned handler", async () => {
    const mic = control("Turn off microphone", { muted: false });
    const model = new HTMLModel();

    const seen: InputDevice[] = [];
    model.onMuteStateChange = (dev) => seen.push(dev);

    mic.setAttribute("data-is-muted", "true");
    await new Promise((r) => setTimeout(r, 0)); // let the MutationObserver flush

    expect(seen).toEqual([InputDevice.MIC]);
  });
});
