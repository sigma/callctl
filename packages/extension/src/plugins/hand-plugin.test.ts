import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UIElement } from "../meet/model.js";
import { type HandModel, ModeledHandAPI } from "./hand-plugin.js";

/**
 * Port of the legacy `google_hand_plugin_test.ts` (ts-mockito → vitest fakes).
 * A fake hand model tracks a `raised` flag and hands back click-through
 * `UIElement`s only for the currently-valid button, exactly as Meet's DOM would
 * expose either "Raise hand" *or* "Lower hand" but never both.
 */
class FakeHandModel implements HandModel {
  raised = false;

  readonly #raise = { click: () => this.setRaised(true) } as unknown as UIElement;
  readonly #lower = { click: () => this.setRaised(false) } as unknown as UIElement;

  setRaised(v: boolean): void {
    this.raised = v;
  }

  onHandStateChange(_listener: () => void): void {}

  getHandState(): boolean {
    return this.raised;
  }

  getElement(label: string): UIElement | undefined {
    if (label === "Raise hand" && !this.raised) {
      return this.#raise;
    }
    if (label === "Lower hand" && this.raised) {
      return this.#lower;
    }
    return undefined;
  }
}

describe("hand API", () => {
  let model: FakeHandModel;
  let api: ModeledHandAPI;

  beforeEach(() => {
    model = new FakeHandModel();
    api = new ModeledHandAPI(model);
  });

  test("raise lowered hand", () => {
    expect(model.raised).toBe(false);
    api.raiseHand();
    expect(model.raised).toBe(true);
  });

  test("lower raised hand", () => {
    model.setRaised(true);
    api.lowerHand();
    expect(model.raised).toBe(false);
  });

  test("toggle lowered hand raises it", () => {
    expect(model.raised).toBe(false);
    api.toggleHand();
    expect(model.raised).toBe(true);
  });

  test("toggle raised hand lowers it", () => {
    model.setRaised(true);
    api.toggleHand();
    expect(model.raised).toBe(false);
  });

  test("raising an already-raised hand is a no-op (no matching button)", () => {
    model.setRaised(true);
    const spy = vi.spyOn(model, "getElement");
    api.raiseHand();
    expect(spy).toHaveReturnedWith(undefined);
    expect(model.raised).toBe(true);
  });
});
