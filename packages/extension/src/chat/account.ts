import type { ChatSelectorConfig, ClientId } from "@callctl/protocol";
import type { Disposer } from "../core/disposer.js";

/**
 * Which Google account this Chat window is signed in as — read from the page
 * itself, at **zero incremental permission cost**, since the
 * `https://chat.google.com/*` host permission is already required for the
 * roster.
 *
 * Deliberately **not** `chrome.identity.getProfileUserInfo`: it reads the
 * *Chrome profile's* primary account, so it returns the same string for both
 * windows in exactly the two-accounts-one-profile case this exists to serve; it
 * is silently wrong when Chrome is signed in as A while Chat is B; it needs the
 * `identity.email` permission, whose user-visible warning would be the only one
 * this extension shows; and it is not callable from a content script anyway.
 */
export interface ChatAccount {
  /** `local@domain`, when the anchor was found and parsed. */
  address?: string;
  /** The full domain — `arbora.partners`, not `arbora`. This is the label. */
  domain?: string;
  localPart?: string;
  /**
   * The `/u/<n>` account index, from the OneGoogle iframe's `src`.
   *
   * 🔴 A **last-resort label component only**. It must never enter the client
   * id: it is a property of the session — Google documents the default as "the
   * one you signed in with first" — so an id built on it would silently
   * re-target every deck binding after a different sign-in order (ADR 0001).
   */
  accountIndex?: number;
}

/**
 * Read whatever the page currently reveals about the signed-in account.
 *
 * The anchor is `a[role="button"][aria-label*="@"]`, whose label reads
 * `Google Account: <Name> \n(<local>@<domain>)`. 🟢 Selecting on the `@` rather
 * than the English "Google Account:" prefix is what makes this locale-
 * invariant — a *better* position than the roster tokens are in.
 *
 * ⚠️ Timing is not guaranteed. The anchor was present a few seconds after load;
 * whether it exists at `document_idle` was never measured, so callers must
 * treat an empty result as "not yet" rather than "not signed in" — see
 * {@link observeAccount}.
 */
export function readAccount(doc: Document, config: ChatSelectorConfig): ChatAccount {
  const account: ChatAccount = {};

  const anchor = doc.querySelector(config.selectors.accountAnchor);
  const address = extractAddress(anchor?.getAttribute("aria-label") ?? "");
  if (address !== undefined) {
    account.address = address;
    const at = address.lastIndexOf("@");
    account.localPart = address.slice(0, at);
    account.domain = address.slice(at + 1);
  }

  const index = accountIndex(doc);
  if (index !== undefined) {
    account.accountIndex = index;
  }

  return account;
}

/**
 * Pull the address out of the anchor's label.
 *
 * **Lexical token extraction, not parsing**: split on whitespace and
 * punctuation the label is known to wrap the address in, and take the token
 * bearing an `@`. Nothing here tries to validate an address — it only has to
 * pick the right token out of a human-facing string.
 */
function extractAddress(label: string): string | undefined {
  for (const token of label.split(/[\s()<>,;"']+/)) {
    const at = token.lastIndexOf("@");
    if (at > 0 && at < token.length - 1) {
      return token;
    }
  }
  return undefined;
}

/**
 * The `/u/<n>` account index, read from the OneGoogle iframe's `src`
 * (`https://ogs.google.com/u/0/widget/app?…`).
 *
 * Reading the attribute is same-document; nothing here touches the iframe's
 * cross-origin content.
 */
function accountIndex(doc: Document): number | undefined {
  for (const frame of doc.querySelectorAll("iframe")) {
    const match = /\/u\/(\d+)\//.exec(frame.getAttribute("src") ?? "");
    if (match?.[1] !== undefined) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * The best name we can give this client right now.
 *
 * The ladder, worst case last: **domain → local part → account index → id
 * stub**. (The two rungs above these — a user-set label, and the plugin's
 * last-known-good cache — live plugin-side, next to the key that displays them.)
 *
 * It bottoms out in something rather than nothing on purpose: a client that
 * cannot name itself is still a client somebody has to bind a key to, and a
 * blank entry in a dropdown is a broken binding rather than a missing label.
 *
 * `"Chat 1"` is explicitly *not* on this ladder. An ordinal over connections is
 * the auto-assign-by-slot ADR 0001 already rejected, and a silently-swapped
 * label is worse than a swapped binding because it lies rather than fails.
 */
export function accountLabel(account: ChatAccount, id: ClientId): string {
  if (account.domain !== undefined && account.domain !== "") {
    // The **full** domain travels. The plugin strips the TLD for display,
    // because the full domain is cramped to unreadable at key size — so the raw
    // fact stays on the wire and presentation lives next to the renderer.
    return account.domain;
  }
  if (account.localPart !== undefined && account.localPart !== "") {
    return account.localPart;
  }
  if (account.accountIndex !== undefined) {
    return `Chat u/${account.accountIndex}`;
  }
  return `Chat · ${id.slice(0, 4)}`;
}

/**
 * Watch for account discovery improving, and call back when it does.
 *
 * The anchor may not exist at `document_idle` — that was never measured — so
 * this observes rather than sampling once. The callback fires only on a genuine
 * improvement, so a client that already knows its domain is not re-handshaking
 * on every Chat re-render.
 */
export function observeAccount(
  doc: Document,
  config: () => ChatSelectorConfig,
  onChange: (account: ChatAccount) => void,
): Disposer {
  let last = JSON.stringify(readAccount(doc, config()));

  const observer = new MutationObserver(() => {
    const account = readAccount(doc, config());
    const serialized = JSON.stringify(account);
    if (serialized === last) {
      return;
    }
    last = serialized;
    onChange(account);
  });
  observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true });

  return () => observer.disconnect();
}
