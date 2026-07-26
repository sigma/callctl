import { DEFAULT_PORT } from "@callctl/protocol";

/**
 * Options page: edit the local bridge port. Ported from the legacy `options.ts`
 * with its bugs fixed — the old version read `input.nodeValue` (always null),
 * saved to `local` but restored from `sync` (so it never round-tripped), and
 * hard-coded the default port. Here we read `input.value`, and both save to and
 * restore from `local` — matching where the content script reads the port.
 */

function saveOptions(doc: Document, local: chrome.storage.LocalStorageArea): void {
  const input = doc.getElementById("port") as HTMLInputElement | null;
  const port = Number.parseInt(input?.value ?? "", 10);
  if (Number.isNaN(port)) {
    return;
  }

  local.set({ port }, () => {
    const status = doc.getElementById("status");
    if (status !== null) {
      status.textContent = "Options saved.";
      setTimeout(() => {
        status.textContent = "";
      }, 750);
    }
  });
}

function restoreOptions(doc: Document, local: chrome.storage.LocalStorageArea): void {
  local.get<{ port: number }>({ port: DEFAULT_PORT }, (items) => {
    const input = doc.getElementById("port") as HTMLInputElement | null;
    if (input !== null) {
      input.value = String(items.port);
    }
  });
}

function installOptions(
  doc: Document = document,
  local: chrome.storage.LocalStorageArea = chrome.storage.local,
): void {
  doc.addEventListener("DOMContentLoaded", () => restoreOptions(doc, local));
  doc.getElementById("save")?.addEventListener("click", () => saveOptions(doc, local));
}

installOptions();
