import type { ChatConversation, ChatRoster, ChatSelectorConfig } from "@callctl/protocol";

/**
 * How the roster reads an element's **rendered** text.
 *
 * 🔴 This exists because rendered text is the whole discriminator, and it is
 * not something a test environment provides. Chat ships a screen-reader
 * `Unread` marker on *every* row — read, unread, and the row currently open —
 * and hides it with CSS. Text content therefore reports **everything** as
 * unread; only layout-aware text tells the states apart.
 *
 * ⚠️ jsdom does not implement it: the property is `undefined`, and falling back
 * to text content returns the hidden marker. So the port is injected — real in
 * the browser, fixture-supplied in tests. **The CSS semantics itself is browser
 * truth, verified through the dev bridge, and is not covered by a unit test.**
 */
export type VisibleText = (el: Element) => string;

/**
 * The browser implementation: `innerText`, which respects layout.
 *
 * ⚠️ Called on the **row**, never on the marker. `innerText` on an element that
 * is itself `display: none` falls back to text content, so querying the marker
 * directly still returns `"Unread"` for every row — the same bug one level down.
 */
export const domVisibleText: VisibleText = (el) => (el as HTMLElement).innerText ?? "";

/**
 * Scan the roster and return the **unread** conversations, newest scan wins.
 *
 * Read conversations are never returned: they are noise for the key, and not
 * sending them keeps less of a chat list travelling than the feature needs. It
 * also makes Chat's own "unread filter" toggle harmless — that filter hides
 * read conversations, which we never report anyway.
 */
export function readRoster(
  doc: Document,
  config: ChatSelectorConfig,
  visibleText: VisibleText,
): ChatRoster {
  const conversations: ChatConversation[] = [];

  for (const row of doc.querySelectorAll(config.selectors.row)) {
    // `data-group-id` is both the stable id and the correct filter: suggested
    // contacts, birthday cards and the "Ask Gemini" entry are `role="listitem"`
    // too, and carry no group id. A bare role query returned 28 nodes for 16
    // conversations.
    const id = row.getAttribute(config.attrs.groupId);
    if (id === null || id === "") {
      continue;
    }

    const text = visibleText(row);
    const muted = text.includes(config.tokens.muted);
    // The two tokens are mutually exclusive — a muted row renders the muted
    // form *instead of* the unread one — so either means unread.
    if (!muted && !text.includes(config.tokens.unread)) {
      continue;
    }

    conversations.push({ id, name: conversationName(text, config), muted });
  }

  return { conversations };
}

/**
 * The conversation's display name, from the row's rendered text.
 *
 * Best-effort: the name shares the row with the state markers and a timestamp,
 * so we take the first rendered line that is not itself a marker and strip any
 * marker text from it. Nothing on the unread key displays this — the key shows
 * a count and an account label — so a slightly ragged name costs nothing today;
 * it is carried because the future paging key will need one, and adding it
 * later would be a wire change.
 */
function conversationName(text: string, config: ChatSelectorConfig): string {
  const markers = [config.tokens.unread, config.tokens.muted];
  for (const line of text.split("\n")) {
    let candidate = line;
    for (const marker of markers) {
      candidate = candidate.split(marker).join(" ");
    }
    // Drop the "N Notification(s)" marker, which is a count element that is not
    // a usable count: every observation read `1`, including a conversation with
    // several messages deliberately left outstanding.
    candidate = candidate.replace(/\d+\s+Notifications?/g, " ");
    candidate = candidate.replace(/\s+/g, " ").trim();
    if (candidate !== "") {
      return candidate;
    }
  }
  return "";
}

/** Do two rosters describe the same unread set? Used to suppress no-op pushes. */
export function sameRoster(a: ChatRoster, b: ChatRoster): boolean {
  if (a.conversations.length !== b.conversations.length) {
    return false;
  }
  return a.conversations.every((c, i) => {
    const other = b.conversations[i];
    return (
      other !== undefined && c.id === other.id && c.muted === other.muted && c.name === other.name
    );
  });
}
