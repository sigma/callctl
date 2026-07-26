/**
 * Dev-only debug vocabulary: lets a developer (or an agent) introspect and poke
 * the live Meet DOM through the extension, over the same local websocket the
 * normal protocol uses.
 *
 * This is NOT part of the production control surface. The extension only
 * registers a handler for {@link DebugCommand.Request} in non-production builds
 * (`import.meta.env.MODE !== "production"`), and the Stream Deck plugin never
 * sends it. It exists so we can answer "what does Meet's DOM actually look like
 * right now?" without guessing — the usual cause of a command that builds fine
 * but clicks nothing (Meet renames aria-labels over time).
 *
 * Wire encoding: a debug exchange rides inside the standard {@link Message}
 * envelope with the payload JSON-encoded in `data`, correlated by `id`:
 *   → { event: "debugRequest",  data: JSON.stringify(DebugRequest)  }
 *   ← { event: "debugResponse", data: JSON.stringify(DebugResponse) }
 */

/** Command the bridge sends to the extension. */
export const DebugCommand = {
  Request: "debugRequest",
} as const;

/** Event the extension sends back with the result. */
export const DebugEvent = {
  Response: "debugResponse",
} as const;

/** The operations the debug channel understands. */
export type DebugOp =
  /** Snapshot every interactive control (buttons / aria-label / data-is-muted). */
  | "dump"
  /** Snapshot only controls matching a CSS selector. */
  | "query"
  /** Click the first element matching a CSS selector. */
  | "click";

export interface DebugRequest {
  /** Correlation id echoed back in the matching {@link DebugResponse}. */
  id: string;
  op: DebugOp;
  /** CSS selector (`query`/`click`) or label substring filter (`dump`). */
  arg?: string;
}

/** A flattened view of a single Meet DOM control, tuned for selector hunting. */
export interface DebugControl {
  tag: string;
  ariaLabel: string | null;
  role: string | null;
  ariaPressed: string | null;
  dataIsMuted: string | null;
  disabled: boolean;
  /** Trimmed, truncated `textContent` — handy when there is no aria-label. */
  text: string;
  /** Every attribute on the element — the way to find a stable selector for a
   *  control that has no aria-label (e.g. Meet's `jsname` / `data-*` hooks). */
  attrs: Record<string, string>;
  /** Truncated `outerHTML` of the element (opening tag + a little content). */
  html: string;
}

export interface DebugResponse {
  /** Correlation id from the originating {@link DebugRequest}. */
  id: string;
  ok: boolean;
  error?: string;
  /** For `dump`/`query`: the matched controls. */
  controls?: DebugControl[];
  /** Total matches before any truncation, so callers know if `controls` is clipped. */
  count?: number;
  /** For `click`: whether an element was found and clicked. */
  clicked?: boolean;
}
