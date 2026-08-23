import { RAISE_WINDOW, type RaiseWindowMessage } from "./core/worker-messages.js";

/**
 * MV3 service worker. Still nearly thin: the functional bridge lives in the
 * content scripts (see `content-script.ts`, `chat-content-script.ts`), which
 * outlive the ~30s worker idle kill, so there is nothing here to keep alive.
 *
 * It has exactly one responsibility beyond logging, and only because it must:
 * **`chrome.windows` is not callable from a content script.** Pressing the Chat
 * key sends `chat.raise` to the client, and the client asks the worker to focus
 * its window.
 *
 * ⚠️ No manifest permission is involved. `chrome.windows` is available without
 * one — only reading `url`/`title` off a `tabs.Tab` needs `"tabs"`, which this
 * does not do — so the extension still declares only `storage` and still shows
 * the user no permission warning.
 */
console.log("callctl extension loaded");

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if ((message as Partial<RaiseWindowMessage>)?.type !== RAISE_WINDOW) {
    return;
  }
  // The window id comes from the sender, never from the message: the worker
  // knows which tab spoke, and the content script has no honest way to know its
  // own window id anyway.
  const windowId = sender.tab?.windowId;
  if (windowId === undefined) {
    console.warn("callctl: raise requested by a sender with no window");
    return;
  }
  // Focus only. Raising must not move the user away from whatever conversation
  // is on screen, so nothing here navigates or switches tabs.
  chrome.windows.update(windowId, { focused: true }).catch((err: unknown) => {
    console.error("callctl: failed to raise window:", err);
  });
});
