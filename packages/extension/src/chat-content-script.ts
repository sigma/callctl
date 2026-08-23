import { accountLabel, type ChatAccount, observeAccount, readAccount } from "./chat/account.js";
import { loadChatPlugins } from "./chat/plugins.js";
import { loadChatSelectors, saveChatSelectors } from "./chat/selector-storage.js";
import { chatSelectors } from "./chat/selectors.js";
import { bootstrap } from "./core/bootstrap.js";
import { loadClientId } from "./core/identity.js";

/**
 * The Chat surface's entry point.
 *
 * **Its own file, not a branch inside `content-script.ts`.** Two measured
 * reasons (ADR 0002):
 *  - the Meet plugins **throw** on a page with no mic button — pointing the Meet
 *    content script at Chat dies in `newCorePlugin()` *before the websocket is
 *    dialled*, so the whole script is silently dead;
 *  - crxjs collapses `web_accessible_resources` when two `content_scripts`
 *    entries share one script file: only the last entry's `matches` survives.
 *
 * Everything the two surfaces genuinely share — config, the transport registry,
 * the live config reaction — is `core/bootstrap.ts`, so the next config option
 * cannot be added to one script and forgotten in the other.
 *
 * **ws only.** If both content scripts bound MIDI they would each receive every
 * CC message while sharing one global plugin-CC namespace with no coordination.
 */

async function init(
  local: chrome.storage.LocalStorageArea,
  onChanged: typeof chrome.storage.onChanged,
): Promise<void> {
  // Overlay persisted selector overrides before the first observation. Chat's
  // tokens are locale-sensitive English strings, so this is the path by which a
  // non-English session is made to work at all.
  chatSelectors.apply(await loadChatSelectors(local));

  const plugins = loadChatPlugins({
    persistSelectors: (config) => saveChatSelectors(local, config),
  });

  const id = await loadClientId(local, "chat");

  // Which account this window is. It may not be knowable yet — the anchor was
  // observed a few seconds after load, and whether it exists at `document_idle`
  // was never measured — so read what there is now and refine below.
  let account: ChatAccount = readAccount(document, chatSelectors.all());

  const registry = await bootstrap({
    local,
    onChanged,
    plugins,
    midi: false,
    session: () => ({
      id,
      surface: "chat",
      // The **full** domain travels; the plugin strips the TLD for display.
      label: accountLabel(account, id),
      // Chat's unread markers are English strings, so a non-English UI would
      // silently report zero. Reporting the language makes that diagnosable
      // instead of mysterious.
      lang: document.documentElement.lang || undefined,
    }),
  });

  // Refine rather than reconnect: the handshake's label is refinable by design,
  // so a late-resolving account improves the binding in place.
  observeAccount(
    document,
    () => chatSelectors.all(),
    (next) => {
      account = next;
      registry.refreshSession();
    },
  );
}

function ready(doc: Document, callback: () => void): void {
  if (doc.readyState !== "loading") {
    callback();
  } else {
    doc.addEventListener("DOMContentLoaded", callback);
  }
}

ready(document, () => {
  init(chrome.storage.local, chrome.storage.onChanged).catch((err: unknown) => {
    console.error("callctl: Chat content script failed to start:", err);
  });
});
