import { type Message, StateEvent } from "@callctl/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HTMLModel } from "../meet/model.js";
import type { Transport } from "../transport/transport.js";
import { type CallStateModel, HTMLCallStateModel, ModeledCallState } from "./callstate-plugin.js";

/** A transport that only records what it was asked to send. */
class RecordingTransport {
  readonly sent: Message[] = [];
  send(m: Message): void {
    this.sent.push(m);
  }
}
const asTransport = (t: RecordingTransport): Transport => t as unknown as Transport;

/** Put a "Leave call" button (Meet's in-call proof) into / out of the DOM. */
function setLeaveButton(present: boolean): void {
  const existing = document.querySelector("[data-test-leave]");
  if (present && existing === null) {
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Leave call");
    btn.setAttribute("data-test-leave", "1");
    document.body.appendChild(btn);
  } else if (!present && existing !== null) {
    existing.remove();
  }
}

describe("HTMLCallStateModel.getCallState — join proof (§10)", () => {
  const IN_CALL = "https://meet.google.com/abc-defg-hij";
  const model = () =>
    new HTMLCallStateModel(new HTMLModel(document), document, undefined, () => href);
  let href = IN_CALL;

  beforeEach(() => {
    href = IN_CALL;
    setLeaveButton(false);
  });
  afterEach(() => {
    setLeaveButton(false);
  });

  test("emits gmeet:<code> when the URL code is valid AND the Leave button is present", () => {
    setLeaveButton(true);
    expect(model().getCallState()).toBe("gmeet:abc-defg-hij");
  });

  test("no data in the green room — valid code but no Leave button yet", () => {
    setLeaveButton(false); // admitted-but-not-joined: same URL, no Leave button
    expect(model().getCallState()).toBeUndefined();
  });

  test("no data when the URL carries no valid meeting code", () => {
    setLeaveButton(true);
    href = "https://meet.google.com/landing"; // not a xxx-xxxx-xxx code
    expect(model().getCallState()).toBeUndefined();
  });

  test("no data on a non-Meet host even with a Leave button present", () => {
    setLeaveButton(true);
    href = "https://example.com/abc-defg-hij";
    expect(model().getCallState()).toBeUndefined();
  });

  test("tolerates an unparseable href", () => {
    setLeaveButton(true);
    href = "not a url";
    expect(model().getCallState()).toBeUndefined();
  });
});

describe("ModeledCallState — pushing the wire signal (§10)", () => {
  /** A minimal fake model whose join key the test drives directly. */
  class FakeCallStateModel implements CallStateModel {
    key: string | undefined;
    onCallStateChange(): () => void {
      return () => {};
    }
    getCallState(): string | undefined {
      return this.key;
    }
  }

  test("sends the namespaced code as data when joined", () => {
    const model = new FakeCallStateModel();
    model.key = "gmeet:abc-defg-hij";
    const t = new RecordingTransport();
    new ModeledCallState(model).sendCallState(asTransport(t));
    expect(t.sent).toEqual([{ event: StateEvent.CallState, data: "gmeet:abc-defg-hij" }]);
  });

  test("sends the event with no data when not in a call", () => {
    const model = new FakeCallStateModel();
    model.key = undefined;
    const t = new RecordingTransport();
    new ModeledCallState(model).sendCallState(asTransport(t));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].event).toBe(StateEvent.CallState);
    expect(t.sent[0].data).toBeUndefined();
  });
});
