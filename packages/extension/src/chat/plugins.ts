import type { SurfacePlugin } from "../core/plugin.js";
import { newDebugPlugin } from "../plugins/debug-plugin.js";
import { newRosterPlugin, RosterModel } from "./roster-plugin.js";
import { newChatSelectorsPlugin, type PersistChatSelectors } from "./selectors-plugin.js";

/**
 * The Chat surface's plugin set. Adding a capability = write a factory and add
 * it here; the handshake's capability set is derived from whatever these
 * register, so nothing else needs updating.
 *
 * The DebugPlugin is included only in non-production builds, exactly as on Meet:
 * Vite statically replaces `import.meta.env.MODE`, so `vite build` tree-shakes
 * both the branch and the import away. It is surface-neutral — it introspects
 * whichever DOM it is loaded into — and having it here is what makes hunting
 * Chat selector drift through the dev bridge possible at all.
 */
export function loadChatPlugins(
  opts: { persistSelectors?: PersistChatSelectors; model?: RosterModel } = {},
): SurfacePlugin[] {
  const plugins = [
    newRosterPlugin(opts.model ?? new RosterModel()),
    newChatSelectorsPlugin(opts.persistSelectors),
  ];
  if (import.meta.env.MODE !== "production") {
    plugins.push(newDebugPlugin());
  }
  return plugins;
}
