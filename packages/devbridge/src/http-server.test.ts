import type { AddressInfo } from "node:net";
import {
  DebugCommand,
  DebugEvent,
  type DebugRequest,
  type Message,
  message,
} from "@callctl/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket as WsClient } from "ws";
import { DebugBridge } from "./debug-bridge.js";
import { startHttp } from "./http-server.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () =>
      predicate()
        ? resolve()
        : Date.now() - started > ms
          ? reject(new Error("waitFor timed out"))
          : setTimeout(tick, 5);
    tick();
  });
}

async function setup() {
  const bridge = new DebugBridge({ extensionPort: 0 });
  await bridge.start();
  cleanups.push(() => bridge.close());
  const extPort = bridge.address?.port as number;

  const server = await startHttp(bridge, 0);
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ext = new WsClient(`ws://127.0.0.1:${extPort}`);
  cleanups.push(() => ext.close());
  await new Promise<void>((r) => ext.once("open", () => r()));
  ext.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as Message;
    if (m.event === DebugCommand.Request) {
      const req = JSON.parse(m.data ?? "{}") as DebugRequest;
      ext.send(
        JSON.stringify(
          message(
            DebugEvent.Response,
            JSON.stringify({ id: req.id, ok: true, controls: [], count: 0, clicked: true }),
          ),
        ),
      );
    }
  });
  await waitFor(() => bridge.state.extensionConnected);
  return { bridge, base, ext };
}

describe("HTTP facade", () => {
  test("GET /health reports connection state", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, extensionConnected: true });
  });

  test("GET /dump proxies a debug op to the extension", async () => {
    const { base } = await setup();
    const body = await (await fetch(`${base}/dump?q=hand`)).json();
    expect(body).toMatchObject({ ok: true, count: 0 });
  });

  test("GET /click requires a selector", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/click`);
    expect(res.status).toBe(400);
  });

  test("GET /command injects a raw command at the extension", async () => {
    const { base, ext } = await setup();
    const received = new Promise<Message>((r) =>
      ext.once("message", (raw) => {
        const m = JSON.parse(raw.toString()) as Message;
        if (m.event !== DebugCommand.Request) {
          r(m);
        }
      }),
    );
    const body = await (await fetch(`${base}/command?event=toggleHand`)).json();
    expect(body).toMatchObject({ ok: true, sent: { event: "toggleHand" } });
    expect(await received).toEqual({ event: "toggleHand" });
  });

  test("unknown route 404s", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
