import {
  DebugCommand,
  type DebugControl,
  DebugEvent,
  type DebugRequest,
  type DebugResponse,
  message,
} from "@callctl/protocol";
import type { Transport } from "../transport/transport.js";
import type { MeetPlugin } from "./plugin.js";

/**
 * Dev-only introspection/manipulation of the live Meet DOM. Registered by
 * `loadPlugins()` **only in non-production builds** so a shipped extension
 * carries zero debug surface.
 *
 * It answers a {@link DebugRequest} by running the op against `document` and
 * pushing back a {@link DebugResponse}. This is what lets an agent ask "what is
 * the actual aria-label of the raise-hand button *right now*?" instead of
 * hard-coding a guess that Meet has since renamed.
 */

/** Controls we consider "interactive" for a bare `dump` (no selector given). */
const DUMP_SELECTOR = "button, [role='button'], [aria-label], [data-is-muted]";

/** Cap payload size; Meet pages can have hundreds of nodes. */
const MAX_CONTROLS = 400;
const MAX_TEXT = 80;
const MAX_HTML = 300;

function attrsOf(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of el.attributes) {
    attrs[a.name] = a.value;
  }
  return attrs;
}

function describe(el: Element): DebugControl {
  return {
    tag: el.tagName.toLowerCase(),
    ariaLabel: el.getAttribute("aria-label"),
    role: el.getAttribute("role"),
    ariaPressed: el.getAttribute("aria-pressed"),
    dataIsMuted: el.getAttribute("data-is-muted"),
    disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
    text: (el.textContent ?? "").trim().slice(0, MAX_TEXT),
    attrs: attrsOf(el),
    html: el.outerHTML.slice(0, MAX_HTML),
  };
}

function collect(doc: Document, selector: string, labelFilter?: string): DebugControl[] {
  const seen = new Set<Element>();
  for (const el of doc.querySelectorAll(selector)) {
    seen.add(el);
  }
  let controls = [...seen].map(describe);
  if (labelFilter !== undefined && labelFilter !== "") {
    const needle = labelFilter.toLowerCase();
    controls = controls.filter(
      (c) =>
        (c.ariaLabel?.toLowerCase().includes(needle) ?? false) ||
        c.text.toLowerCase().includes(needle),
    );
  }
  return controls;
}

function runOp(doc: Document, req: DebugRequest): DebugResponse {
  switch (req.op) {
    case "dump": {
      const all = collect(doc, DUMP_SELECTOR, req.arg);
      return { id: req.id, ok: true, controls: all.slice(0, MAX_CONTROLS), count: all.length };
    }
    case "query": {
      if (!req.arg) {
        return { id: req.id, ok: false, error: "query requires a CSS selector in `arg`" };
      }
      const all = collect(doc, req.arg);
      return { id: req.id, ok: true, controls: all.slice(0, MAX_CONTROLS), count: all.length };
    }
    case "click": {
      if (!req.arg) {
        return { id: req.id, ok: false, error: "click requires a CSS selector in `arg`" };
      }
      const el = doc.querySelector<HTMLElement>(req.arg);
      el?.click();
      return { id: req.id, ok: true, clicked: el !== null };
    }
    default:
      return { id: req.id, ok: false, error: `unknown op: ${(req as DebugRequest).op}` };
  }
}

class DebugPlugin implements MeetPlugin {
  readonly #doc: Document;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  ID(): number {
    return 999;
  }

  installHooks(_t: Transport): void {}

  installHandlers(t: Transport): void {
    t.handle(DebugCommand.Request, (msg) => {
      let response: DebugResponse;
      try {
        const req = JSON.parse(msg.data ?? "{}") as DebugRequest;
        response = runOp(this.#doc, req);
      } catch (e) {
        response = { id: "", ok: false, error: `bad debug request: ${(e as Error).message}` };
      }
      t.send(message(DebugEvent.Response, JSON.stringify(response)));
    });
  }
}

export function newDebugPlugin(): MeetPlugin {
  console.log("loading debug plugin (dev build)");
  return new DebugPlugin();
}
