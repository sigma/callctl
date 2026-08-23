/**
 * The Google Chat surface's wire vocabulary.
 *
 * Namespaced `chat.*`, like every surface's ops, because op names are the
 * bridge's routing keys and must be unique across surfaces (ADR 0001).
 */

/** Commands the plugin sends to a Chat client. */
export const ChatCommand = {
  /** Explicit resync. The client already pushes on connect and on change. */
  GetRoster: "chat.getRoster",
  /**
   * Bring this client's Chat window to the front. **Takes no arguments.**
   *
   * Press raises the window; it does not navigate. The future paging key will
   * add an optional conversation target *additively*, needing no new command —
   * so shipping the field now would be unused API inviting use before its
   * semantics are settled.
   */
  Raise: "chat.raise",
  SetSelectors: "chat.setSelectors",
  GetSelectors: "chat.getSelectors",
} as const;
export type ChatCommand = (typeof ChatCommand)[keyof typeof ChatCommand];

/** State events a Chat client pushes back. */
export const ChatEvent = {
  /** Full {@link ChatRoster} JSON. */
  Roster: "chat.roster",
  /** Full {@link ChatSelectorConfig} JSON, pushed after get/set-selectors. */
  Selectors: "chat.selectors",
} as const;
export type ChatEvent = (typeof ChatEvent)[keyof typeof ChatEvent];

/** One **unread** conversation. Read conversations are never sent. */
export interface ChatConversation {
  /**
   * The row's `data-group-id` — stable, and exactly the REST resource name
   * modulo pluralisation (`space/AAQ…` ↔ `spaces/AAQ…`; `dm/<id>` for DMs).
   */
  id: string;
  name: string;
  /**
   * Unread but muted.
   *
   * Reported, **not counted**: muting is a deliberate statement that a space
   * should not interrupt, and a deck key is an interrupting surface. It rides
   * on the entry rather than being filtered client-side so the wire stays
   * descriptive and the plugin decides what to count.
   */
  muted: boolean;
}

/**
 * A **full snapshot of the unread conversations**, pushed on connect and on
 * every change — not a delta.
 *
 * The roster is tiny (16 conversations observed, 0–3 of them unread), so a
 * delta protocol would cost sequence numbers plus a resync path after every
 * reconnect and buy nothing; a snapshot is idempotent and self-healing.
 *
 * There is deliberately **no count field** — no trustworthy per-conversation
 * message count exists anywhere — and **no completeness marker**: sending only
 * unread conversations already neutralises Chat's own unread filter, leaving
 * only virtualisation, which the extension cannot reliably detect. A `complete`
 * flag would be guesswork the plugin would then trust.
 */
export interface ChatRoster {
  conversations: ChatConversation[];
}

/**
 * Chat's selector configuration.
 *
 * **Structured by kind, not a flat `Record<key, string>`** (ADR 0002): these
 * are three different kinds of value, and flattening them would give a reader
 * no way to know that `unread` is matched against *rendered* text while `row`
 * is passed to `querySelectorAll`.
 */
export interface ChatSelectorConfig {
  /** Passed to `querySelectorAll`. */
  selectors: {
    /**
     * A conversation row.
     *
     * `data-group-id` is both the id and the correct filter: suggested
     * contacts, birthday cards and the "Ask Gemini" entry are `role="listitem"`
     * too — a bare role query returned 28 nodes for 16 conversations.
     */
    row: string;
    /**
     * The signed-in account anchor, whose `aria-label` carries the address.
     *
     * 🟢 Selected on the presence of an `@` rather than the English
     * "Google Account:" prefix, which makes this one selector locale-invariant:
     * an address contains `@` in every locale.
     */
    accountAnchor: string;
  };
  /**
   * Matched against a row's **rendered** text.
   *
   * 🔴 Rendered, not text content. Chat ships a screen-reader `Unread` marker on
   * *every* row and hides it with CSS, so a scraper reading text content reports
   * everything as unread. And it must be read **on the row**, not on the marker:
   * rendered text on an element that is itself hidden falls back to text content.
   *
   * 🟡 These are English UI strings. A non-English Chat renders `Non lus` and
   * every signal silently returns zero — the same failure mode as a renamed
   * class, triggered by locale instead of a deploy. The mitigation is diagnosis,
   * not translation: the client reports its UI language at handshake, so the
   * mismatch is visible rather than mysterious.
   */
  tokens: {
    /** Present ⇒ unread **and** notifying. */
    unread: string;
    /** Present ⇒ unread but muted. Mutually exclusive with {@link unread}. */
    muted: string;
  };
  /** Attribute names. */
  attrs: {
    groupId: string;
  };
}

/**
 * The compiled-in defaults, verified live against Chat on 2026-08-23.
 *
 * 🔴 Note what is *not* here: the generated class names (`H7du2` notifying,
 * `mznwRb` muted) reproduce the same partition, but Google regenerates them per
 * deploy. They are in `docs/research/chat-roster-dom.md` §7 for diagnosis only
 * and must never be used as selectors.
 */
export const DEFAULT_CHAT_SELECTORS: ChatSelectorConfig = {
  selectors: {
    row: '[data-group-id][role="listitem"]',
    accountAnchor: 'a[role="button"][aria-label*="@"]',
  },
  tokens: {
    unread: "Unread",
    muted: "Muted,",
  },
  attrs: {
    groupId: "data-group-id",
  },
};

/**
 * Merge an untrusted partial override onto a base config, one group at a time.
 *
 * Unknown keys, and non-string or empty values, are ignored — so a malformed
 * push can only ever fail to change a selector, never blank one out and leave
 * the surface reporting an empty roster.
 */
export function mergeChatSelectors(
  base: ChatSelectorConfig,
  partial: Partial<Record<string, unknown>>,
): ChatSelectorConfig {
  return {
    selectors: mergeGroup(base.selectors, partial.selectors),
    tokens: mergeGroup(base.tokens, partial.tokens),
    attrs: mergeGroup(base.attrs, partial.attrs),
  };
}

function mergeGroup<T extends Record<string, string>>(base: T, override: unknown): T {
  if (typeof override !== "object" || override === null) {
    return { ...base };
  }
  const out: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (key in base && typeof value === "string" && value !== "") {
      out[key] = value;
    }
  }
  return out as T;
}
