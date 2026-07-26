/**
 * The single JSON envelope exchanged over the local websocket between the
 * Stream Deck plugin (server, port 2395) and the Chrome extension (client).
 *
 * Faithful port of `meetremote/internal/api.Message`.
 */
export interface Message {
  event: string;
  /** Omitted on the wire when empty (Go used `json:"data,omitempty"`). */
  data?: string;
}

/** Build a Message, dropping `data` when empty to match the Go `omitempty`. */
export function message(event: string, data?: string): Message {
  return data === undefined || data === "" ? { event } : { event, data };
}
