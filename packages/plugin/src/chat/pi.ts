import type { ChatClient } from "../remote/chat-remote.js";

/**
 * The Property Inspector's client picker.
 *
 * A pure handler over the attached-client list, so the wire round-trip is the
 * only SDK-coupled part — the same split `calendar/test-feed.ts` uses for the
 * `[Test]` button, and the reason both are testable without a Stream Deck.
 *
 * The PI asks; the plugin answers with **currently-attached** clients. That is
 * the whole point: binding a key means picking "work" out of a list of names,
 * not copying an opaque id out of a log. A client that is not attached cannot be
 * newly bound — but an existing binding to it survives untouched, since the
 * binding lives on the key, not in this list.
 */

/** The PI's request. */
export const LIST_CHAT_CLIENTS = "listChatClients";

/** The plugin's reply. */
export const CHAT_CLIENTS = "chatClients";

export interface ChatClientsReply {
  command: typeof CHAT_CLIENTS;
  clients: ChatClient[];
}

/**
 * Answer a `listChatClients` message, or `null` for anything else — so the
 * plugin's single `onSendToPlugin` sink can route several PIs' messages by
 * trying each handler in turn.
 */
export function handlePiChatClientsMessage(
  payload: unknown,
  clients: () => ChatClient[],
): ChatClientsReply | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { command?: unknown }).command !== LIST_CHAT_CLIENTS
  ) {
    return null;
  }
  return { command: CHAT_CLIENTS, clients: clients() };
}
