import { describe, expect, it } from "vitest";

import type { ChatClient } from "../remote/chat-remote.js";
import { handlePiChatClientsMessage } from "./pi.js";

const clients: ChatClient[] = [
  { id: "c-work", label: "arbora.partners" },
  { id: "c-home", label: "gmail.com" },
];

describe("the Property Inspector's client list", () => {
  it("lists attached clients by label, so binding means picking a name", () => {
    const reply = handlePiChatClientsMessage({ command: "listChatClients" }, () => clients);

    expect(reply).toEqual({ command: "chatClients", clients });
    // The labels are the full domains; the *key* strips the TLD, the dropdown
    // does not — it has to tell acme.com from acme.dev.
    expect(reply?.clients.map((c) => c.label)).toEqual(["arbora.partners", "gmail.com"]);
  });

  it("reports an empty list rather than failing when nothing is attached", () => {
    expect(handlePiChatClientsMessage({ command: "listChatClients" }, () => [])).toEqual({
      command: "chatClients",
      clients: [],
    });
  });

  it("declines anything that is not its message", () => {
    // The plugin has one `onSendToPlugin` sink shared with the calendar PI, so
    // declining is how a message reaches the right handler.
    expect(handlePiChatClientsMessage({ command: "testFeed" }, () => clients)).toBeNull();
    expect(handlePiChatClientsMessage(null, () => clients)).toBeNull();
    expect(handlePiChatClientsMessage("listChatClients", () => clients)).toBeNull();
  });
});
