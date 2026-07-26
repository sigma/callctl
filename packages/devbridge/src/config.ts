import { DEFAULT_PORT } from "@callctl/protocol";

/**
 * Bridge configuration, resolved from CLI flags first, then env vars, then
 * defaults. Env fallback exists so the MCP entry can be configured from
 * `.mcp.json` (which passes args) or the environment interchangeably.
 *
 *   --extension-port <n>  / MEETDECK_EXTENSION_PORT   (default 2395)
 *   --plugin-port    <n>  / MEETDECK_PLUGIN_PORT      (unset → debug-only)
 *   --http-port      <n>  / MEETDECK_HTTP_PORT        (default 2397)
 *   --host        <addr>  / MEETDECK_HOST             (default 127.0.0.1)
 */
export interface Config {
  extensionPort: number;
  pluginPort?: number;
  httpPort: number;
  host: string;
}

export function parseConfig(argv: string[] = process.argv.slice(2), env = process.env): Config {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }

  const num = (flag: string, envKey: string, fallback?: number): number | undefined => {
    const raw = flags.get(flag) ?? env[envKey];
    if (raw === undefined) {
      return fallback;
    }
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) {
      throw new Error(`invalid number for --${flag}: ${raw}`);
    }
    return n;
  };

  return {
    extensionPort: num("extension-port", "MEETDECK_EXTENSION_PORT", DEFAULT_PORT) as number,
    pluginPort: num("plugin-port", "MEETDECK_PLUGIN_PORT"),
    httpPort: num("http-port", "MEETDECK_HTTP_PORT", 2397) as number,
    host: flags.get("host") ?? env.MEETDECK_HOST ?? "127.0.0.1",
  };
}
