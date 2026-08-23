import type { AddressInfo } from "node:net";
import {
  Command,
  DebugCommand,
  DebugEvent,
  type DebugRequest,
  type Message,
  message,
  SessionEvent,
  StateEvent,
} from "@callctl/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { type WebSocket, WebSocketServer, WebSocket as WsClient } from "ws";
import { DebugBridge } from "./debug-bridge.js";

/**
 * These tests drive the bridge over real `ws` sockets — a fake extension dials
 * in, and (for the proxy tests) a fake plugin listens upstream. They are the
 * mirror image of the extension's `ws-transport.test.ts`.
 *
 * A client handshakes on connect, declaring the ops its plugins would have
 * registered: routing reads that derived capability set and an un-handshaken
 * client is refused outright (ADR 0001).
 */

/** What a Meet content script's plugins register, debug surface included. */
const MEET_OPS: string[] = [
  ...Object.values(Command),
  ...Object.values(StateEvent),
  DebugCommand.Request,
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started > ms) {
        reject(new Error("waitFor timed out"));
      } else {
        setTimeout(tick, 5);
      }
    };
    tick();
  });
}

function nextMessage(ws: WebSocket | WsClient): Promise<Message> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Message));
  });
}

/** Dial the bridge and handshake, so the client is actually routable. */
async function connectClient(
  port: number,
  id = "fake-meet",
  surface = "meet",
  ops: string[] = MEET_OPS,
): Promise<WsClient> {
  const ws = new WsClient(`ws://127.0.0.1:${port}`);
  cleanups.push(() => ws.close());
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify(message(SessionEvent.Hello, JSON.stringify({ id, surface, ops }))));
  return ws;
}

/** Start a bridge on an ephemeral extension port, and connect a fake extension. */
async function setup(opts: { autoRespond?: boolean; pluginPort?: number } = {}) {
  const bridge = new DebugBridge({ extensionPort: 0, pluginPort: opts.pluginPort });
  await bridge.start();
  cleanups.push(() => bridge.close());

  const extPort = bridge.address?.port;
  if (extPort === undefined) {
    throw new Error("bridge not listening");
  }

  const ext = await connectClient(extPort);

  if (opts.autoRespond) {
    ext.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Message;
      if (m.event === DebugCommand.Request) {
        const req = JSON.parse(m.data ?? "{}") as DebugRequest;
        ext.send(
          JSON.stringify(
            message(
              DebugEvent.Response,
              JSON.stringify({
                id: req.id,
                ok: true,
                controls: [{ tag: "button", ariaLabel: `echo:${req.op}:${req.arg ?? ""}` }],
                count: 1,
              }),
            ),
          ),
        );
      }
    });
  }

  await waitFor(() => bridge.state.extensionConnected);
  return { bridge, ext };
}

describe("DebugBridge", () => {
  test("debug round-trips a request to the extension and resolves the response", async () => {
    const { bridge } = await setup({ autoRespond: true });
    const res = await bridge.debug("dump", "hand");
    expect(res.ok).toBe(true);
    expect(res.controls?.[0]?.ariaLabel).toBe("echo:dump:hand");
  });

  test("debug rejects when no extension is connected", async () => {
    const bridge = new DebugBridge({ extensionPort: 0 });
    await bridge.start();
    cleanups.push(() => bridge.close());
    await expect(bridge.debug("dump")).rejects.toThrow(/no extension/);
  });

  test("sendCommand injects a raw command at the extension", async () => {
    const { bridge, ext } = await setup();
    const received = nextMessage(ext);
    bridge.sendCommand("meet.toggleHand");
    expect(await received).toEqual({ event: "meet.toggleHand" });
  });

  test("caches mic/camera/hand state pushed by the extension", async () => {
    const { bridge, ext } = await setup();
    ext.send(JSON.stringify(message("meet.micState", "muted")));
    await waitFor(() => bridge.state.mic === "muted");
    expect(bridge.state.mic).toBe("muted");
  });

  test("proxies commands plugin→extension and state extension→plugin", async () => {
    // Fake plugin server on an ephemeral port.
    const pluginServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => pluginServer.close());
    const pluginConn = new Promise<WebSocket>((r) => pluginServer.once("connection", r));
    await new Promise<void>((r) => pluginServer.once("listening", () => r()));
    const pluginPort = (pluginServer.address() as AddressInfo).port;

    const { bridge, ext } = await setup({ pluginPort });
    const plugin = await pluginConn;
    await waitFor(() => bridge.state.pluginConnected);

    // plugin → extension
    const atExt = nextMessage(ext);
    plugin.send(JSON.stringify(message("meet.toggleMic")));
    expect(await atExt).toEqual({ event: "meet.toggleMic" });

    // extension → plugin
    const atPlugin = nextMessage(plugin);
    ext.send(JSON.stringify(message("meet.micState", "muted")));
    // The source client rides along now, so the plugin can tell whose state moved.
    expect(await atPlugin).toEqual({
      event: "meet.micState",
      data: "muted",
      client: "fake-meet",
    });
  });

  test("does NOT forward debug responses upstream to the plugin", async () => {
    const pluginServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => pluginServer.close());
    const pluginConn = new Promise<WebSocket>((r) => pluginServer.once("connection", r));
    await new Promise<void>((r) => pluginServer.once("listening", () => r()));
    const pluginPort = (pluginServer.address() as AddressInfo).port;

    const { bridge, ext } = await setup({ pluginPort });
    const plugin = await pluginConn;
    await waitFor(() => bridge.state.pluginConnected);

    let leaked = false;
    plugin.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Message;
      if (m.event === DebugEvent.Response) {
        leaked = true;
      }
    });

    // Extension emits a debug response unprompted; it must be intercepted.
    ext.send(JSON.stringify(message(DebugEvent.Response, JSON.stringify({ id: "x", ok: true }))));
    // Also send a normal state event to give the plugin *something* to receive.
    ext.send(JSON.stringify(message("meet.micState", "muted")));
    await waitFor(() => bridge.state.mic === "muted");
    expect(leaked).toBe(false);
  });

  test("getSelectors requests and resolves the config the extension pushes", async () => {
    const { bridge, ext } = await setup();
    ext.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Message;
      if (m.event === "meet.getSelectors") {
        ext.send(
          JSON.stringify(message("meet.selectors", JSON.stringify({ leave: "Leave call" }))),
        );
      }
    });
    await expect(bridge.getSelectors()).resolves.toEqual({ leave: "Leave call" });
  });

  test("setSelectors sends the partial and resolves the merged config back", async () => {
    const { bridge, ext } = await setup();
    const seen = new Promise<Message>((r) => {
      ext.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as Message;
        if (m.event === "meet.setSelectors") {
          r(m);
          ext.send(JSON.stringify(message("meet.selectors", JSON.stringify({ handRaise: "Up" }))));
        }
      });
    });
    const result = await bridge.setSelectors({ handRaise: "Up" });
    expect(JSON.parse((await seen).data ?? "{}")).toEqual({ handRaise: "Up" });
    expect(result).toEqual({ handRaise: "Up" });
  });

  test("does NOT forward selector pushes upstream to the plugin", async () => {
    const pluginServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => pluginServer.close());
    const pluginConn = new Promise<WebSocket>((r) => pluginServer.once("connection", r));
    await new Promise<void>((r) => pluginServer.once("listening", () => r()));
    const pluginPort = (pluginServer.address() as AddressInfo).port;

    const { bridge, ext } = await setup({ pluginPort });
    const plugin = await pluginConn;
    await waitFor(() => bridge.state.pluginConnected);

    let leaked = false;
    plugin.on("message", (raw) => {
      if ((JSON.parse(raw.toString()) as Message).event === "meet.selectors") {
        leaked = true;
      }
    });

    ext.send(JSON.stringify(message("meet.selectors", JSON.stringify({ leave: "x" }))));
    ext.send(JSON.stringify(message("meet.micState", "muted")));
    await waitFor(() => bridge.state.mic === "muted");
    expect(leaked).toBe(false);
  });

  describe("multiple clients", () => {
    const CHAT_OPS = ["chat.getRoster", "chat.raise", DebugCommand.Request];

    test("a Meet and a Chat client coexist without evicting each other", async () => {
      const { bridge, ext } = await setup();
      const chat = await connectClient(bridge.address?.port as number, "c1", "chat", CHAT_OPS);
      await waitFor(() => bridge.clients.length === 2);

      // This is the defect the shared registry fixes: introspecting the Chat DOM
      // used to mean closing every Meet tab.
      expect(bridge.clients.map((c) => c.surface).sort()).toEqual(["chat", "meet"]);
      expect(ext.readyState).toBe(WsClient.OPEN);
      expect(chat.readyState).toBe(WsClient.OPEN);
    });

    test("a debug op can name which client's DOM to introspect", async () => {
      const { bridge } = await setup({ autoRespond: true });
      const chat = await connectClient(bridge.address?.port as number, "c1", "chat", CHAT_OPS);
      chat.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as Message;
        if (m.event === DebugCommand.Request) {
          const req = JSON.parse(m.data ?? "{}") as DebugRequest;
          chat.send(
            JSON.stringify(
              message(
                DebugEvent.Response,
                JSON.stringify({
                  id: req.id,
                  ok: true,
                  controls: [{ tag: "span", ariaLabel: `chat:${req.arg ?? ""}` }],
                  count: 1,
                }),
              ),
            ),
          );
        }
      });
      await waitFor(() => bridge.clients.length === 2);

      const res = await bridge.debug("query", "[data-group-id]", "c1");
      expect(res.controls?.[0]?.ariaLabel).toBe("chat:[data-group-id]");
    });

    test("targeting an absent client fails by name rather than timing out", async () => {
      const { bridge } = await setup();
      await expect(bridge.debug("dump", undefined, "nope")).rejects.toThrow(/nope/);
    });

    test("a command with no client goes last-wins, as a single-client session always did", async () => {
      const { bridge, ext } = await setup();
      const received = nextMessage(ext);
      bridge.sendCommand("meet.toggleHand");
      expect(await received).toEqual({ event: "meet.toggleHand" });
    });
  });
});
