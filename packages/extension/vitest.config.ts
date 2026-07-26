import { defineConfig } from "vitest/config";

/**
 * Test config kept separate from `vite.config.ts` on purpose: the `@crxjs`
 * plugin rewrites entry points and expects the extension runtime, which breaks
 * plain unit tests. Here we just want a DOM (`jsdom`) so the Meet model/API
 * tests can build fixture elements and drive `MutationObserver`s.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
