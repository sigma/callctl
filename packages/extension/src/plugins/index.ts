import { newCallStatePlugin } from "./callstate-plugin.js";
import { newCaptionsPlugin } from "./captions-plugin.js";
import { newCorePlugin } from "./core-plugin.js";
import { newDebugPlugin } from "./debug-plugin.js";
import { newHandPlugin } from "./hand-plugin.js";
import type { MeetPlugin } from "./plugin.js";
import { newReactPlugin } from "./react-plugin.js";
import { newSelectorsPlugin, type PersistSelectors } from "./selectors-plugin.js";

/**
 * The plugin registry — an explicit list replacing the legacy webpack
 * `val-loader` trick (`plugins_loader.js`), which code-generated one import per
 * `*_plugin.ts`. Adding a capability = write a `new<Name>Plugin()` factory and
 * add it here. No bundler magic.
 *
 * The DebugPlugin is included only in non-production builds. Vite statically
 * replaces `import.meta.env.MODE`, so `vite build` (MODE = "production") tree-
 * shakes both the branch and the import away — a shipped extension carries no
 * debug surface. `vite` dev and `vite build --mode debug` keep it.
 */
export function loadPlugins(opts: { persistSelectors?: PersistSelectors } = {}): MeetPlugin[] {
  const plugins = [
    newCorePlugin(),
    // After core: chains core's `onConnect` for its own on-connect push (§10).
    newCallStatePlugin(),
    newHandPlugin(),
    newCaptionsPlugin(),
    newReactPlugin(),
    newSelectorsPlugin(opts.persistSelectors),
  ];
  if (import.meta.env.MODE !== "production") {
    plugins.push(newDebugPlugin());
  }
  return plugins;
}
