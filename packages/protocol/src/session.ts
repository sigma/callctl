/**
 * The session layer: who is on the other end of a socket, and what they can do.
 *
 * The local bridge used to keep exactly one connection, which was correct while
 * the extension had one content script. A second surface (`chat.google.com`)
 * breaks it immediately — the two clients evict each other in a loop. So the
 * bridge keeps many clients, and needs to know which one an operation belongs
 * to. See [ADR 0001](../../../docs/adr/0001-multi-client-capability-handshake.md).
 */

/**
 * A client's identity: opaque, minted once per extension install into
 * `chrome.storage.local` (which is per-Chrome-profile), stable across
 * reconnects, Chat reloads and browser restarts.
 *
 * **Opaque `string`, deliberately not a UUID.** The unit today is the profile,
 * but one profile signed into two accounts yields one install and two Chat
 * windows. Keeping the id opaque makes adding an account discriminator later a
 * *value* change rather than a schema change.
 *
 * 🔴 **The account index (`/u/<n>`) must never enter this value.** It is a
 * property of the session — Google documents the default account as "the one
 * you signed in with first" — so an id built on it would silently re-target
 * every deck binding after a different sign-in order.
 */
export type ClientId = string;

/** Session-layer operations. Surface-neutral, so not `meet.*` / `chat.*`. */
export const SessionEvent = {
  /**
   * The mandatory handshake, sent by the client the moment its socket opens and
   * again whenever a refinable field improves. `data` is a JSON-encoded
   * {@link ClientHello}.
   */
  Hello: "session.hello",
} as const;
export type SessionEvent = (typeof SessionEvent)[keyof typeof SessionEvent];

/**
 * The handshake payload.
 *
 * **Capabilities are derived, not declared.** {@link ops} is literally the set
 * of op names the client's plugins registered on its transport, captured when
 * the socket opens. There is no `Command → capability` table anywhere, so the
 * capability set cannot drift from the operations that actually exist — it is
 * automatically correct the moment someone adds a plugin.
 */
export interface ClientHello {
  id: ClientId;

  /**
   * A coarse self-declared surface name (`"meet"`, `"chat"`).
   *
   * **For logs and UI only.** Routing goes through {@link ops}; making this
   * load-bearing would reintroduce the hardcoded role enum that makes every new
   * surface a protocol edit at both ends.
   */
  surface: string;

  /** Every op this client handles. The capability set. */
  ops: string[];

  /**
   * A human name for this client — for Chat, the **full account domain**
   * (`arbora.partners`).
   *
   * ⚠️ Consumers may not display this verbatim: the Chat key strips the TLD,
   * because the full domain is cramped to unreadable at key size. The raw fact
   * travels and presentation lives next to the renderer, so a future consumer
   * that *does* need to tell `acme.com` from `acme.dev` needs no wire change.
   *
   * Optional and **refinable**: account discovery may resolve seconds after the
   * page loads, so a client may handshake without a label and send a second
   * hello once it knows. Consumers cache last-known-good.
   */
  label?: string;

  /**
   * `document.documentElement.lang` on the client's page. Optional, refinable.
   *
   * Not decoration: Chat's unread markers are English strings, so a non-English
   * Chat silently reports zero unread. Reporting the language turns that from a
   * mystery into a diagnosis.
   */
  lang?: string;
}

/** Parse an untrusted handshake payload, or `undefined` if it is not one. */
export function parseHello(data: string | undefined): ClientHello | undefined {
  if (data === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const hello = raw as Partial<ClientHello>;
  if (typeof hello.id !== "string" || hello.id === "") {
    return undefined;
  }
  if (typeof hello.surface !== "string" || hello.surface === "") {
    return undefined;
  }
  if (!Array.isArray(hello.ops) || hello.ops.some((op) => typeof op !== "string")) {
    return undefined;
  }
  return {
    id: hello.id,
    surface: hello.surface,
    ops: hello.ops,
    ...(typeof hello.label === "string" ? { label: hello.label } : {}),
    ...(typeof hello.lang === "string" ? { lang: hello.lang } : {}),
  };
}
