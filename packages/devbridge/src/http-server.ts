import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DebugOp } from "@meetdeck/protocol";
import type { DebugBridge } from "./debug-bridge.js";

/**
 * A tiny loopback HTTP facade over {@link DebugBridge}, so the debug ops are one
 * `curl` away — ideal for driving from a shell. All routes return JSON.
 *
 *   GET  /health | /state
 *   GET  /dump?q=<substr>          introspect all controls (optional filter)
 *   GET  /query?selector=<css>     introspect controls matching a selector
 *   GET  /click?selector=<css>     click the first match
 *   GET  /command?event=<e>&data=<d>   inject a raw command at the extension
 *   POST /command  { "event": "...", "data": "..." }
 *   GET  /selectors                    read the extension's live selector config
 *   POST /selectors  { "handRaise": "...", ... }   push a partial override
 */
export function startHttp(bridge: DebugBridge, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    handle(bridge, req, res).catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function handle(
  bridge: DebugBridge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams;
  const path = url.pathname;

  if (path === "/health" || path === "/state") {
    return sendJson(res, 200, { ok: true, ...bridge.state });
  }

  if (path === "/dump") {
    return sendJson(res, 200, await bridge.debug("dump", q.get("q") ?? undefined));
  }

  if (path === "/query" || path === "/click") {
    const selector = q.get("selector") ?? q.get("q") ?? undefined;
    if (selector === undefined) {
      return sendJson(res, 400, { ok: false, error: "missing `selector`" });
    }
    return sendJson(res, 200, await bridge.debug(path.slice(1) as DebugOp, selector));
  }

  if (path === "/command") {
    let event = q.get("event") ?? undefined;
    let data = q.get("data") ?? undefined;
    if (req.method === "POST") {
      const body = await readBody(req);
      if (body !== "") {
        const parsed = JSON.parse(body) as { event?: string; data?: string };
        event = parsed.event ?? event;
        data = parsed.data ?? data;
      }
    }
    if (event === undefined) {
      return sendJson(res, 400, { ok: false, error: "missing `event`" });
    }
    bridge.sendCommand(event, data);
    return sendJson(res, 200, { ok: true, sent: { event, data } });
  }

  if (path === "/selectors") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const partial = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
      return sendJson(res, 200, { ok: true, selectors: await bridge.setSelectors(partial) });
    }
    return sendJson(res, 200, { ok: true, selectors: await bridge.getSelectors() });
  }

  return sendJson(res, 404, { ok: false, error: `no route for ${path}` });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}
