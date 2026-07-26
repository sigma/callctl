import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config.js";

/**
 * Vite build for the MV3 extension. `@crxjs/vite-plugin` takes the TS manifest,
 * bundles every entry it references (content script, service worker, options
 * page), rewrites paths, copies `public/`, and wires HMR in `vite` dev mode —
 * replacing the legacy webpack config *and* its `val-loader` plugin trick (the
 * plugin set is now an explicit registry in `src/plugins/index.ts`).
 */
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Chrome rejects extensions whose sources reference sourcemaps that aren't
    // shipped; keep the unpacked `dist/` self-contained.
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
