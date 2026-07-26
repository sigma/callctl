import { Command, REACTION_SLUGS, reactionLabel } from "@meetdeck/protocol";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Meet reactions. Reworked for current Meet: the old `.emojiPng[alt="…"]` grid
 * is gone. Reactions now live behind a `"Send a reaction"` button and each is a
 * `button[aria-label="<glyph>"]` (the emoji glyph is the accessible label). So
 * to react we open the panel if needed, then click the glyph's button.
 *
 * The wire `data` is the glyph (from `@meetdeck/protocol`'s `reactionLabel`).
 * The MIDI transport still delivers reactions as an ordinal ("3") rather than a
 * glyph, so a numeric `data` indexes into the canonical slug order.
 */

const REACTION_OPENER = "Send a reaction";
const OPEN_WAIT_MS = 1500;

/**
 * Find a reaction button by its glyph using a **prefix** match. When a skin tone
 * is selected, Meet appends a Fitzpatrick modifier to the emoji buttons that
 * support one (👍→👍🏽, 👎, 👏), so their `aria-label` is no longer exactly the
 * base glyph. An exact match would miss — and worse, `react()` would then assume
 * the panel is closed and click "Send a reaction", *toggling the panel* instead
 * of reacting. Prefix-matching hits both `"👍"` and `"👍🏽"`; it is unambiguous
 * because no base reaction glyph is a prefix of another.
 *
 * We filter in JS rather than with a CSS `[aria-label^="…"]` selector: emoji are
 * surrogate pairs, which the CSS attribute-prefix operator mishandles in some
 * engines (jsdom), whereas `String.prototype.startsWith` is reliable everywhere.
 */
function glyphButton(doc: Document, glyph: string): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>("button[aria-label]")) {
    if ((el.getAttribute("aria-label") ?? "").startsWith(glyph)) {
      return el;
    }
  }
  return null;
}

/** Resolve `data` to a glyph: a numeric ordinal (MIDI) maps via slug order. */
function toGlyph(data: string): string | undefined {
  const n = Number.parseInt(data, 10);
  if (!Number.isNaN(n)) {
    const slug = REACTION_SLUGS[n];
    return slug === undefined ? undefined : reactionLabel(slug);
  }
  return data;
}

/** Poll for a selector to appear (the reaction panel opens asynchronously). */
function waitFor(find: () => HTMLElement | null, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = find();
      if (el !== null) {
        resolve(el);
      } else if (Date.now() - started > timeoutMs) {
        resolve(null);
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
  });
}

export class ReactAPI {
  readonly #doc: Document;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  async react(data: string): Promise<void> {
    const glyph = toGlyph(data);
    if (glyph === undefined) {
      return;
    }

    let button = glyphButton(this.#doc, glyph);
    if (button === null) {
      // Panel is closed — open it, then wait for the glyph button to render.
      this.#doc.querySelector<HTMLElement>(`button[aria-label="${REACTION_OPENER}"]`)?.click();
      button = await waitFor(() => glyphButton(this.#doc, glyph), OPEN_WAIT_MS);
    }
    button?.click();
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
    t.handle(Command.React, (msg) => {
      // Fire-and-forget: opening the panel is async, but the transport handler
      // is synchronous and has no reply to send.
      void api.react(msg.data ?? "");
    });
  }
}

export function newReactPlugin(): MeetPlugin {
  console.log("loading google react plugin");
  return new ReactPlugin();
}
