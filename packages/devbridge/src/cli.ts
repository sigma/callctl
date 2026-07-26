import { parseConfig } from "./config.js";
import { DebugBridge } from "./debug-bridge.js";
import { startHttp } from "./http-server.js";

/**
 * Default run mode: bridge + HTTP facade. Launch instead of (or in front of)
 * the Stream Deck plugin; then curl the debug ops.
 *
 *   pnpm -F @meetdeck/devbridge start                 # debug-only on :2395
 *   pnpm -F @meetdeck/devbridge start --plugin-port 2395 --extension-port 2396
 */
async function main(): Promise<void> {
  const cfg = parseConfig();
  const log = (m: string) => console.error(`[devbridge] ${m}`);

  const bridge = new DebugBridge({
    extensionPort: cfg.extensionPort,
    pluginPort: cfg.pluginPort,
    host: cfg.host,
    log,
  });
  await bridge.start();
  await startHttp(bridge, cfg.httpPort, cfg.host);
  log(`HTTP debug API on http://${cfg.host}:${cfg.httpPort} (try /health, /dump?q=hand)`);

  const shutdown = () => {
    log("shutting down");
    bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[devbridge] fatal: ${err}`);
  process.exit(1);
});
