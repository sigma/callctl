import { afterEach, describe, expect, test, vi } from "vitest";
import type { Message } from "../transport/transport.js";
import { ModeledAPI, ModeledState } from "./api.js";
import { HTMLModel, InputDevice } from "./model.js";

/**
 * DOM-level tests for the Meet model/API under jsdom. These pin the selector
 * contract (aria-label / data-is-muted) the whole port hinges on, and prove the
 * push-back: a DOM-driven mute change must actually reach the subscribed
 * `onMuteStateChange` listeners so the plugin's toggle LEDs can follow.
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
    const people = control("People");
    const chat = control("Chat with everyone");
    const api = new ModeledAPI(new HTMLModel());

    api.leaveCall();
    api.toggleParticipants();
    api.toggleChat();

    expect(leave.click).toHaveBeenCalledOnce();
    expect(people.click).toHaveBeenCalledOnce();
    expect(chat.click).toHaveBeenCalledOnce();
  });

  test("toggleParticipants finds the People button labelled via aria-labelledby", () => {
    // Mirror current Meet: the participants button has no aria-label; its name
    // comes from a referenced element (the model must resolve aria-labelledby).
    const labelSpan = document.createElement("span");
    labelSpan.id = "people-label";
    labelSpan.textContent = "People";
    document.body.appendChild(labelSpan);

    const button = document.createElement("div");
    button.setAttribute("role", "button");
    button.setAttribute("aria-labelledby", "people-label");
    button.click = vi.fn();
    document.body.appendChild(button);

    new ModeledAPI(new HTMLModel()).toggleParticipants();
    expect(button.click).toHaveBeenCalledOnce();
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

describe("mute-state push-back", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("an in-place data-is-muted change reaches the reassigned handler", async () => {
    const mic = control("Turn off microphone", { muted: false });
    const model = new HTMLModel();

    const seen: InputDevice[] = [];
    model.onMuteStateChange((dev) => seen.push(dev));

    mic.setAttribute("data-is-muted", "true");
    await flush();

    expect(seen).toEqual([InputDevice.MIC]);
  });

  test("a node-replacement change (Meet's re-render) is detected too", async () => {
    // The real-world failure: Meet swaps the control for a fresh node rather
    // than mutating data-is-muted in place, so an attribute-only observer never
    // fired. The re-scan must still notice the new state.
    const mic = control("Turn off microphone", { muted: false });
    const model = new HTMLModel();

    const seen: InputDevice[] = [];
    model.onMuteStateChange((dev) => seen.push(dev));

    mic.remove();
    control("Turn off microphone", { muted: true });
    await flush();

    expect(seen).toEqual([InputDevice.MIC]);
  });

  test("does not re-notify when the state hasn't actually changed", async () => {
    const mic = control("Turn off microphone", { muted: false });
    const model = new HTMLModel();

    const seen: InputDevice[] = [];
    model.onMuteStateChange((dev) => seen.push(dev));

    mic.setAttribute("data-is-muted", "true"); // real change → one push
    await flush();
    mic.setAttribute("data-is-muted", "true"); // no-op mutation → must not push again
    await flush();

    expect(seen).toEqual([InputDevice.MIC]);
  });

  test("the returned disposer removes just that listener (no leak on detach)", async () => {
    const mic = control("Turn off microphone", { muted: false });
    const model = new HTMLModel();

    const seen: InputDevice[] = [];
    const dispose = model.onMuteStateChange((dev) => seen.push(dev));

    dispose(); // as a disabled transport's detach would
    mic.setAttribute("data-is-muted", "true");
    await flush();

    expect(seen).toEqual([]); // the unsubscribed listener never fires
  });
});
