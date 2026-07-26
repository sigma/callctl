import { Command } from "@meetdeck/protocol";
import type { AriaElement } from "../meet/model.js";
import { UIElement } from "../meet/model.js";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Meet reactions. Faithful port of the legacy `google_react_plugin.ts` (Go
 * `!public` build tag). The `react` command's `data` is the Meet emoji `alt`
 * text — exactly the label `@meetdeck/protocol`'s `reactionLabel(slug)`
 * produces, so the plugin and extension agree without any per-emoji table here.
 *
 * The numeric-index path is retained: the MIDI transport delivers a reaction as
 * an ordinal (`data = "3"`) rather than a label, so a numeric `data` selects the
 * Nth emoji button instead of matching `alt` text.
 *
 * The legacy `getReactions`/`reactions` round-trip is dropped: it is not part of
 * the `@meetdeck/protocol` contract and the `MeetRemote` server never sends it.
 */

function getEmojiByLabel(doc: Document, alt: string): UIElement | undefined {
  const icon = doc.querySelector<AriaElement>(`.emojiPng[alt="${alt}"]`);
  return icon === null ? undefined : new UIElement(icon);
}

function getEmojiByIndex(doc: Document, idx: number): UIElement | undefined {
  const emojis = doc.querySelectorAll<AriaElement>(".emojiPng");
  const icon = emojis.item(idx);
  return icon === null ? undefined : new UIElement(icon);
}

class ReactAPI {
  readonly #doc: Document;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  react(emoji: string): void {
    const n = Number.parseInt(emoji, 10);
    if (Number.isNaN(n)) {
      getEmojiByLabel(this.#doc, emoji)?.click();
    } else {
      getEmojiByIndex(this.#doc, n)?.click();
    }
  }
}

class ReactPlugin implements MeetPlugin {
  readonly #api: ReactAPI;

  constructor() {
    this.#api = new ReactAPI();
  }

  ID(): number {
    return 101;
  }

  installHooks(_t: Transport): void {}

  installHandlers(t: Transport): void {
    const api = this.#api;
    t.handle(Command.React, (msg) => api.react(msg.data ?? ""));
  }
}

export function newReactPlugin(): MeetPlugin {
  console.log("loading google react plugin");
  return new ReactPlugin();
}
