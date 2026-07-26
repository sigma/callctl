import { loadConfig, saveConfig, type TransportConfig } from "../config.js";

/**
 * Options page: edit the one-time advanced settings the in-Meet widget relies
 * on — today the two ws ports (the normal plugin port and the dev-bridge port).
 * The frequent in-call toggles (enable/disable each transport, MIDI device
 * selection) live in the widget, not here.
 *
 * Both edit the same versioned `config` envelope (see `../config.ts`), so the
 * open page stays in sync with edits made elsewhere via `chrome.storage.onChanged`:
 * a widget (or another Options tab) writing `config` re-populates these fields.
 * Saves read-modify-write the full envelope so we never clobber the transport
 * settings this page doesn't render (`enabled` flags, MIDI devices).
 */

function readPort(doc: Document, id: string): number | null {
  const input = doc.getElementById(id) as HTMLInputElement | null;
  const port = Number.parseInt(input?.value ?? "", 10);
  return Number.isNaN(port) ? null : port;
}

function writePort(doc: Document, id: string, port: number): void {
  const input = doc.getElementById(id) as HTMLInputElement | null;
  if (input !== null) {
    input.value = String(port);
  }
}

function render(doc: Document, config: TransportConfig): void {
  writePort(doc, "port", config.ws.port);
  writePort(doc, "dev-bridge-port", config.ws.devBridge.port);
}

function showStatus(doc: Document, message: string): void {
  const status = doc.getElementById("status");
  if (status !== null) {
    status.textContent = message;
    setTimeout(() => {
      status.textContent = "";
    }, 750);
  }
}

async function saveOptions(doc: Document, local: chrome.storage.LocalStorageArea): Promise<void> {
  const port = readPort(doc, "port");
  const devBridgePort = readPort(doc, "dev-bridge-port");
  if (port === null || devBridgePort === null) {
    return;
  }

  const config = await loadConfig(local);
  await saveConfig(local, {
    ...config,
    ws: {
      ...config.ws,
      port,
      devBridge: { ...config.ws.devBridge, port: devBridgePort },
    },
  });
  showStatus(doc, "Options saved.");
}

async function restoreOptions(
  doc: Document,
  local: chrome.storage.LocalStorageArea,
): Promise<void> {
  render(doc, await loadConfig(local));
}

function installOptions(
  doc: Document = document,
  local: chrome.storage.LocalStorageArea = chrome.storage.local,
  onChanged: typeof chrome.storage.onChanged = chrome.storage.onChanged,
): void {
  doc.addEventListener("DOMContentLoaded", () => restoreOptions(doc, local));
  doc.getElementById("save")?.addEventListener("click", () => saveOptions(doc, local));

  // Reflect edits made elsewhere (the in-Meet widget, another Options tab) into
  // the open page without a reload.
  onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && "config" in changes) {
      const next = changes.config.newValue as TransportConfig | undefined;
      if (next !== undefined) {
        render(doc, next);
      }
    }
  });
}

installOptions();

export { installOptions, restoreOptions, saveOptions };
