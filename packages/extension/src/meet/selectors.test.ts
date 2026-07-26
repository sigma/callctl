import { DEFAULT_SELECTORS, SelectorKey } from "@callctl/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { newSelectorsPlugin } from "../plugins/selectors-plugin.js";
import type { Message } from "../transport/transport.js";
import { ModeledAPI } from "./api.js";
import { HTMLModel } from "./model.js";
import { SelectorRegistry } from "./selectors.js";

/**
 * Config-over-the-wire selectors: the match strings each Meet control is found
 * by are runtime data, so a drift fix can be pushed over the websocket without
 * rebuilding the content script (which would need a call-dropping tab reload).
 * These tests pin (1) the merge semantics and (2) that an override actually
 * redirects a DOM lookup, and (3) the plugin's get/set round-trip.
 */

function button(label: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", label);
  Object.defineProperty(el, "ariaLabel", { value: label, configurable: true });
  el.click = vi.fn();
  document.body.appendChild(el);
  return el;
}

/** A fake Transport that just records what the plugin sends and lets us fire
 *  the handlers it registered. */
function fakeTransport() {
  const sent: Message[] = [];
  const handlers = new Map<string, (m: Message) => void>();
  return {
    sent,
    fire: (event: string, data?: string) => handlers.get(event)?.({ event, data }),
    transport: {
      onConnect: () => {},
      send: (m: Message) => sent.push(m),
      handle: (op: string, h: (m: Message) => void) => handlers.set(op, h),
      shutdown: () => {},
      acceptPlugin: () => {},
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SelectorRegistry", () => {
  test("defaults come from DEFAULT_SELECTORS", () => {
    const reg = new SelectorRegistry();
    expect(reg.get(SelectorKey.Leave)).toBe(DEFAULT_SELECTORS.leave);
    expect(reg.all()).toEqual(DEFAULT_SELECTORS);
  });

  test("apply merges a partial and ignores unknown/empty/non-string keys", () => {
    const reg = new SelectorRegistry();
    reg.apply({ leave: "Hang up", bogus: "x", chat: "", participants: 42 });
    expect(reg.get(SelectorKey.Leave)).toBe("Hang up"); // overridden
    expect(reg.get(SelectorKey.Chat)).toBe(DEFAULT_SELECTORS.chat); // empty ignored
    expect(reg.get(SelectorKey.Participants)).toBe(DEFAULT_SELECTORS.participants); // non-string ignored
    expect("bogus" in reg.all()).toBe(false);
  });

  test("initial overrides are applied at construction", () => {
    const reg = new SelectorRegistry({ mic: "mikrofon" });
    expect(reg.get(SelectorKey.Mic)).toBe("mikrofon");
  });
});

describe("override redirects the DOM lookup", () => {
  test("a pushed `leave` override makes the API click the renamed button", () => {
    const reg = new SelectorRegistry();
    const oldButton = button("Leave call");
    const renamed = button("End call for everyone");
    const api = new ModeledAPI(new HTMLModel(document, reg), reg);

    api.leaveCall();
    expect(oldButton.click).toHaveBeenCalledOnce(); // default still matches
    expect(renamed.click).not.toHaveBeenCalled();

    reg.apply({ leave: "End call" });
    api.leaveCall();
    expect(renamed.click).toHaveBeenCalledOnce(); // now the override matches
  });
});

describe("SelectorsPlugin round-trip", () => {
  test("getSelectors pushes the current full config", () => {
    const reg = new SelectorRegistry();
    const { sent, fire, transport } = fakeTransport();
    newSelectorsPlugin(undefined, reg).installHandlers(transport);

    fire("getSelectors");
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe("selectors");
    expect(JSON.parse(sent[0].data ?? "{}")).toEqual(DEFAULT_SELECTORS);
  });

  test("setSelectors merges, persists, and pushes back the merged config", () => {
    const reg = new SelectorRegistry();
    const persisted: unknown[] = [];
    const { sent, fire, transport } = fakeTransport();
    newSelectorsPlugin((c) => persisted.push(c), reg).installHandlers(transport);

    fire("setSelectors", JSON.stringify({ handRaise: "Put hand up" }));

    expect(reg.get(SelectorKey.HandRaise)).toBe("Put hand up");
    expect(persisted).toHaveLength(1);
    const pushed = JSON.parse(sent.at(-1)?.data ?? "{}");
    expect(pushed.handRaise).toBe("Put hand up");
  });

  test("a malformed setSelectors payload is ignored, not destructive", () => {
    const reg = new SelectorRegistry();
    const { fire, transport } = fakeTransport();
    newSelectorsPlugin(() => {}, reg).installHandlers(transport);

    fire("setSelectors", "}{ not json");
    expect(reg.all()).toEqual(DEFAULT_SELECTORS);
  });
});
