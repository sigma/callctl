import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseConfig } from "./config.js";
import { DebugBridge } from "./debug-bridge.js";

/**
 * MCP run mode: bridge + a stdio MCP server exposing the debug ops as tools, so
 * an agent can introspect/drive the live Meet DOM as first-class tool calls.
 * Register in `.mcp.json` (see deck/.mcp.json). Binds the extension port itself,
 * so don't run this and the HTTP `cli` at the same time.
 *
 * stdout is owned by the MCP stdio transport — all logging goes to stderr.
 */
function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: String(err instanceof Error ? err.message : err) }],
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig();
  const log = (m: string) => console.error(`[devbridge-mcp] ${m}`);

  const bridge = new DebugBridge({
    extensionPort: cfg.extensionPort,
    pluginPort: cfg.pluginPort,
    host: cfg.host,
    log,
  });
  await bridge.start();

  const server = new McpServer({ name: "callctl-devbridge", version: "0.0.0" });

  server.registerTool(
    "meet_state",
    {
      description:
        "Current bridge/Meet state: whether the extension and plugin are connected, and cached mic/camera/hand state.",
      inputSchema: {},
    },
    async () => jsonResult(bridge.state),
  );

  server.registerTool(
    "callctl_clients",
    {
      description:
        "List every attached client — its id, surface (meet/chat), label and the ops it handles. With more than one attached, 'the extension' is no longer a single thing: pass an id as `client` to the tools below to introspect that one specifically.",
      inputSchema: {},
    },
    async () => jsonResult({ clients: bridge.clients }),
  );

  server.registerTool(
    "meet_dump",
    {
      description:
        "Snapshot every interactive Meet control (buttons, [aria-label], [data-is-muted]) with its attributes. Optional `q` filters by aria-label/text substring. Use this to find the real aria-label of a control before wiring it up.",
      inputSchema: {
        q: z.string().optional().describe("case-insensitive label/text filter"),
        client: z
          .string()
          .optional()
          .describe("client id to target; omit for last-wins (see callctl_clients)"),
      },
    },
    async ({ q, client }) => {
      try {
        return jsonResult(await bridge.debug("dump", q, client));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "meet_query",
    {
      description: "Snapshot Meet controls matching a CSS selector, with their attributes.",
      inputSchema: {
        selector: z.string().describe("CSS selector"),
        client: z
          .string()
          .optional()
          .describe("client id to target; omit for last-wins (see callctl_clients)"),
      },
    },
    async ({ selector, client }) => {
      try {
        return jsonResult(await bridge.debug("query", selector, client));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "meet_click",
    {
      description: "Click the first Meet element matching a CSS selector.",
      inputSchema: {
        selector: z.string().describe("CSS selector"),
        client: z
          .string()
          .optional()
          .describe("client id to target; omit for last-wins (see callctl_clients)"),
      },
    },
    async ({ selector, client }) => {
      try {
        return jsonResult(await bridge.debug("click", selector, client));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "meet_command",
    {
      description:
        "Inject a raw protocol command at the extension (e.g. event 'meet.toggleHand', 'meet.react' with data 'waving hand'). Bypasses the plugin — useful to exercise a command directly.",
      inputSchema: {
        event: z.string().describe("protocol event name"),
        data: z.string().optional().describe("optional data payload"),
        client: z
          .string()
          .optional()
          .describe("client id to target; omit for last-wins (see callctl_clients)"),
      },
    },
    async ({ event, data, client }) => {
      try {
        bridge.sendCommand(event, data, client);
        return jsonResult({ ok: true, sent: { event, data } });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "meet_get_selectors",
    {
      description:
        "Read the extension's live Meet selector config (the match strings each control is found by). Use this to see what a control is currently matched on before overriding it.",
      inputSchema: {
        client: z
          .string()
          .optional()
          .describe("client id to target; omit for last-wins (see callctl_clients)"),
      },
    },
    async ({ client }) => {
      try {
        return jsonResult(await bridge.getSelectors(client));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "meet_set_selectors",
    {
      description:
        "Fix Meet selector drift at runtime WITHOUT a rebuild or tab reload (which would drop the call). Push a partial override map keyed by selector name (mic, camera, leave, participants, chat, handRaise, handLower, reactionOpener); the value is the new accessible-name substring. Returns the merged config. The override persists in the extension across reloads.",
      inputSchema: {
        overrides: z
          .record(z.string(), z.string())
          .describe('selector-key → new match substring, e.g. { "handRaise": "Raise hand" }'),
        client: z
          .string()
          .optional()
          .describe("client id to target; omit for last-wins (see callctl_clients)"),
      },
    },
    async ({ overrides, client }) => {
      try {
        return jsonResult(await bridge.setSelectors(overrides, client));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  log(`MCP server ready; bridge on :${cfg.extensionPort}`);
}

main().catch((err) => {
  console.error(`[devbridge-mcp] fatal: ${err}`);
  process.exit(1);
});
