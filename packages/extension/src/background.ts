/**
 * MV3 service worker. Intentionally thin: the functional bridge lives in the
 * content script (see `content-script.ts`), so there is nothing for the worker
 * to keep alive. It exists to satisfy the manifest and give @crxjs an HMR
 * anchor in dev. Mirrors the legacy MV2 `background.ts`, which likewise only
 * logged.
 */
console.log("Meet driver extension loaded");
