import { type ClientHello, type Message, message, SessionEvent } from "@callctl/protocol";
import { WebSocket } from "ws";

/**
 * A fake client for testing a {@link Bridge} **at the socket**, so assertions
 * are about what actually crossed the wire rather than about internal state.
 *
 * Lives in the shared package because every consumer of the bridge needs the
 * same handshake dance, and a copy per package would drift from the protocol
 * the moment the handshake gains a field.
 */
export class FakeClient {
  readonly #ws: WebSocket;
  /** Every frame received, in order. */
  readonly received: Message[] = [];
  readonly #waiters = new Set<(m: Message) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Message;
      this.received.push(m);
      for (const waiter of [...this.#waiters]) {
        this.#waiters.delete(waiter);
        waiter(m);
      }
    });
  }

  /** Dial the bridge and complete the handshake. Resolves once attached. */
  static async connect(port: number, hello: ClientHello): Promise<FakeClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const client = new FakeClient(ws);
    client.send(message(SessionEvent.Hello, JSON.stringify(hello)));
    return client;
  }

  /** Dial without handshaking — the stale-extension case. */
  static async connectRaw(port: number): Promise<FakeClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new FakeClient(ws);
  }

  send(m: Message): void {
    this.#ws.send(JSON.stringify(m));
  }

  /** Resolve on the next frame to arrive. */
  next(): Promise<Message> {
    return new Promise((resolve) => this.#waiters.add(resolve));
  }

  /** Resolve when the bridge closes this socket (the refusal path). */
  closed(): Promise<void> {
    if (this.#ws.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#ws.once("close", () => resolve()));
  }

  close(): Promise<void> {
    const done = this.closed();
    this.#ws.close();
    return done;
  }
}

/**
 * Wait for the event loop to carry a frame across the loopback socket and back.
 * Two turns: one for the send, one for the bridge's reaction to it.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
