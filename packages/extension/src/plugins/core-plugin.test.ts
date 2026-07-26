import type { Message } from "@callctl/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BaseTransport } from "../transport/transport.js";
import { newCorePlugin } from "./core-plugin.js";

/**
 * Guards the load-bearing lifecycle edit: `CorePlugin.installHooks` subscribes
 * to the model's mute changes and must *park the unsubscribe on the transport*,
 * so that detaching the transport (disable) tears the pusher back out of the
 * model. Without that, a disabled transport keeps a dead listener wired in and
 * either leaks or double-pushes after re-enable.
 *
 * Driven through a real jsdom DOM + a real `HTMLModel` (constructed inside the
 * plugin), so it exercises the actual wiring, not a stand-in.
 */

/** A real transport (for detach/onDetach) whose pipe just records sends. */
class RecordingTransport extends BaseTransport {
  readonly sent: Message[] = [];
  send(message: Message): void {
    this.sent.push(message);
  }
  handle(_op: string, _h: (msg: Message) => void): void {}
  protected close(): void {}
}

/** Build a Meet-like mute control, mirroring meet.test.ts's helper. */
function control(label: string, muted: boolean): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", label);
  Object.defineProperty(el, "ariaLabel", { value: label, configurable: true });
  el.setAttribute("data-is-muted", String(muted));
  el.click = vi.fn();
  document.body.appendChild(el);
  return el;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CorePlugin transport lifecycle", () => {
  test("a mute change pushes while attached, and stops after detach", async () => {
    const mic = control("Turn off microphone", false);
    const transport = new RecordingTransport();

    transport.acceptPlugin(newCorePlugin());

    // Attached: a real mute transition reaches the transport.
    mic.setAttribute("data-is-muted", "true");
    await flush();
    expect(transport.sent.length).toBeGreaterThan(0);

    // Detach (as `registry.disable` would), then change again.
    transport.detach();
    const before = transport.sent.length;
    mic.setAttribute("data-is-muted", "false");
    await flush();

    // The parked disposer ran, so the listener is gone — no further push.
    expect(transport.sent.length).toBe(before);
  });
});
