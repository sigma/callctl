import { defineManifest } from "@crxjs/vite-plugin";

/**
 * MV3 manifest for the Meet driver extension.
 *
 * Ported from the legacy MV2 `public/manifest.json`. The key change from MV2 is
 * cosmetic here rather than structural: the functional bridge already lived in
 * the **content script** (long-lived, tied to the Meet tab), not the background
 * page — so moving to an MV3 service worker costs nothing. The service worker
 * stays thin (dev/logging only); the websocket client and Meet-driving logic
 * run in the content script, which outlives the ~30s service-worker idle kill.
 *
 * Notable MV3 differences from the ported MV2 manifest:
 *  - `background.scripts` → `background.service_worker` (module).
 *  - host match strings move from `permissions` into `host_permissions`.
 *  - `options_ui.chrome_style` (removed in MV3) → `open_in_tab`.
 *  - the MV2 `crx-hotreload` background script is gone; @crxjs provides HMR.
 *
 * The pinned `key` is carried over verbatim so the extension keeps its stable
 * ID across the MV2→MV3 migration.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Google Meet Driver",
  description: "Drive Google Meet from the local Stream Deck bridge websocket",
  version: "0.0.1",
  author: { email: "yann.hodique@gmail.com" },
  homepage_url: "https://github.com/sigma/meet-driver",

  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv+i/FGLF/2fYNW4EVu/zAXws9tUzQfnmMJQmgRozC1uDuC8/h8Kku+/TiC01yVePody1i+KuyNIVb7Hh6+G6RDtDRdDzCDlk/Ebn7SpT+B0nmWz83tzIj652OH78B7Z40oaeFOyczYkIpiqLgqeGM/gSfx5hyhSeJU5zn56Eja53GFwV5MTE3VTt2VhOiSbVm7bpTg5CoNMhqqaWtB3dnZoUWGJQG5X/ttozCfVVeY9LPj+LsDgD4A3eLnpOUT0vHN2lFOCHrbxPLOR5lQRyKwtUxiAFglpTQwiPpWv6kJKrj2lfLyW2MYT6o1eCVTp0hKblEPEJU9wPYZ/hoQx7jwIDAQAB",

  icons: {
    16: "public/icons/icon16.png",
    48: "public/icons/icon48.png",
    128: "public/icons/icon128.png",
  },

  background: {
    service_worker: "src/background.ts",
    type: "module",
  },

  content_scripts: [
    {
      matches: ["https://meet.google.com/*"],
      js: ["src/content-script.ts"],
      run_at: "document_idle",
    },
  ],

  options_ui: {
    page: "src/options/options.html",
    open_in_tab: true,
  },

  permissions: ["storage"],
  host_permissions: ["https://meet.google.com/*"],
});
