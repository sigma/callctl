import { newCorePlugin } from "./core-plugin.js";
import { newHandPlugin } from "./hand-plugin.js";
import type { MeetPlugin } from "./plugin.js";
import { newReactPlugin } from "./react-plugin.js";

/**
 * The plugin registry — an explicit list replacing the legacy webpack
 * `val-loader` trick (`plugins_loader.js`), which code-generated one import per
 * `*_plugin.ts`. Adding a capability = write a `new<Name>Plugin()` factory and
 * add it here. No bundler magic.
 */
export function loadPlugins(): MeetPlugin[] {
  return [newCorePlugin(), newHandPlugin(), newReactPlugin()];
}
