import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UIElement } from "../meet/model.js";
import { type CaptionsModel, ModeledCaptionsAPI } from "./captions-plugin.js";

/**
 * Mirrors `hand-plugin.test.ts`. A fake captions model tracks an `on` flag and
 * hands back click-through `UIElement`s only for the currently-valid button,
 * exactly as Meet's DOM exposes either "Turn on captions" *or* "Turn off
 * captions" but never both.
 */
class FakeCaptionsModel implements CaptionsModel {
  on = false;

  readonly #enable = { click: () => this.setOn(true) } as unknown as UIElement;
  readonly #disable = { click: () => this.setOn(false) } as unknown as UIElement;

  setOn(v: boolean): void {
    this.on = v;
  }

  onCaptionsStateChange(_listener: () => void): () => void {
    return () => {};
  }

  getCaptionsState(): boolean {
    return this.on;
  }

  getElement(label: string): UIElement | undefined {
    if (label === "Turn on captions" && !this.on) {
      return this.#enable;
    }
    if (label === "Turn off captions" && this.on) {
      return this.#disable;
    }
    return undefined;
  }
}

describe("captions API", () => {
  let model: FakeCaptionsModel;
  let api: ModeledCaptionsAPI;

  beforeEach(() => {
    model = new FakeCaptionsModel();
    api = new ModeledCaptionsAPI(model);
  });

  test("enable captions when off", () => {
    expect(model.on).toBe(false);
    api.enableCaptions();
    expect(model.on).toBe(true);
  });

  test("disable captions when on", () => {
    model.setOn(true);
    api.disableCaptions();
    expect(model.on).toBe(false);
  });

  test("toggle off captions turns them on", () => {
    expect(model.on).toBe(false);
    api.toggleCaptions();
    expect(model.on).toBe(true);
  });

  test("toggle on captions turns them off", () => {
    model.setOn(true);
    api.toggleCaptions();
    expect(model.on).toBe(false);
  });

  test("enabling already-on captions is a no-op (no matching button)", () => {
    model.setOn(true);
    const spy = vi.spyOn(model, "getElement");
    api.enableCaptions();
    expect(spy).toHaveReturnedWith(undefined);
    expect(model.on).toBe(true);
  });
});
