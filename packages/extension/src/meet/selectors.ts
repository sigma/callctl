import {
  DEFAULT_SELECTORS,
  mergeSelectors,
  type SelectorConfig,
  type SelectorKey,
} from "@callctl/protocol";

/**
 * The extension's live view of the Meet selectors (see the protocol's
 * `selectors.ts` for the why). Seeded from {@link DEFAULT_SELECTORS} and mutated
 * in place by a `setSelectors` push. Every DOM lookup reads `get(key)` fresh, so
 * an override takes effect on the very next command with no rebuild or reload.
 */
export class SelectorRegistry {
  #config: SelectorConfig;

  constructor(initial: Partial<Record<string, unknown>> = {}) {
    this.#config = mergeSelectors(DEFAULT_SELECTORS, initial);
  }

  get(key: SelectorKey): string {
    return this.#config[key];
  }

  all(): SelectorConfig {
    return { ...this.#config };
  }

  /** Merge overrides in and return the resulting full config. */
  apply(partial: Partial<Record<string, unknown>>): SelectorConfig {
    this.#config = mergeSelectors(this.#config, partial);
    return this.all();
  }
}

/**
 * The process-wide registry every plugin's model reads from. It is a shared
 * singleton on purpose: the extension builds several independent
 * {@link import("./model.js").HTMLModel} instances (core + hand), yet a single
 * pushed `setSelectors` must reconfigure them all at once. Unit tests can pass a
 * fresh {@link SelectorRegistry} to isolate.
 */
export const selectors = new SelectorRegistry();
