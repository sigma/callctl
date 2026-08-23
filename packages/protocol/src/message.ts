import type { ClientId } from "./session.js";

/**
 * The single JSON envelope exchanged over the local websocket between the
 * Stream Deck plugin (server, port 2395) and the Chrome extension (client).
 *
 * Faithful port of `meetremote/internal/api.Message`, plus the optional
 * {@link Message.client} address added by ADR 0001.
 */
export interface Message {
  event: string;
  /** Omitted on the wire when empty (Go used `json:"data,omitempty"`). */
  data?: string;

  /**
   * Which client this frame concerns: a **target** on a command, a **source**
   * on a state event.
   *
   * **Absent means last-wins** — the command goes to the most recently attached
   * client that handles the op, which is today's exact Meet semantics (you
   * cannot be in two calls, so a second Meet tab is a stale leftover). Two Chat
   * windows are legitimate, so Chat keys address their client explicitly.
   */
  client?: ClientId;
}

/** Build a Message, dropping `data` when empty to match the Go `omitempty`. */
export function message(event: string, data?: string, client?: ClientId): Message {
  const base: Message = data === undefined || data === "" ? { event } : { event, data };
  return client === undefined ? base : { ...base, client };
}
