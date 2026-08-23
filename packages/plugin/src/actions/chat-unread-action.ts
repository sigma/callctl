import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ChatKeyFace, renderChatKeySvg } from "../chat/render.js";
import type { ChatRemote } from "../remote/chat-remote.js";
import { type ChatUnreadSettings, parseChatUnreadSettings } from "../settings.js";

/**
 * Wrap an SVG document as a base64 `data:` URI for `KeyAction.setImage`. The SDK
 * types accept a bare `<svg>` string, but the Stream Deck app does not reliably
 * render one passed verbatim — it treats it as a file path and silently leaves
 * the manifest's default icon on the key. Same reasoning, same helper shape, as
 * `next-meeting-action.ts`.
 */
function svgToImageUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** One appeared key: its live SDK handle plus its parsed settings. */
interface KeyEntry {
  action: KeyAction;
  settings: ChatUnreadSettings;
}

/**
 * How many Google Chat conversations are waiting.
 *
 * All the decision logic lives outside this class — {@link ChatRemote} owns the
 * rosters and the bindings, {@link renderChatKeySvg} owns the face — so this is
 * only SDK wiring: appearance, settings, and `setImage`. That is the same split
 * `NextMeetingAction` uses, and it is what makes the key testable by asserting
 * on what it was *asked to render* rather than on internals.
 *
 * **Bound but absent renders as no-client.** There is no fourth visual:
 * "nothing attached at all" and "my client specifically is away" are the same
 * thing from the key's point of view, and both are fixed by pressing it.
 */
export class ChatUnreadAction extends SingletonAction {
  readonly #remote: ChatRemote;
  readonly #keys = new Map<string, KeyEntry>();

  constructor(uuid: string, remote: ChatRemote) {
    super();
    (this as { manifestId: string }).manifestId = uuid;
    this.#remote = remote;

    // Repaint whenever a client attaches, detaches, or pushes a new roster.
    remote.onChange(() => this.refreshAll());
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) {
      return;
    }
    this.#keys.set(ev.action.id, {
      action: ev.action,
      settings: parseChatUnreadSettings(ev.payload.settings),
    });
    this.#paint(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.#keys.delete(ev.action.id);
  }

  /**
   * Press brings the Chat window to the front.
   *
   * With the bound client attached, the plugin sends `chat.raise` to **that**
   * client, so with two Chat windows open the right one comes forward.
   */
  override onKeyDown(ev: KeyDownEvent): void {
    const entry = this.#keys.get(ev.action.id);
    if (entry === undefined) {
      return;
    }
    this.#remote.raise(entry.settings.clientId);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
    const entry = this.#keys.get(ev.action.id);
    if (entry === undefined) {
      return;
    }
    entry.settings = parseChatUnreadSettings(ev.payload.settings);
    this.#paint(ev.action.id);
  }

  /** Repaint every appeared key. Public so the plugin can force a refresh. */
  refreshAll(): void {
    for (const id of this.#keys.keys()) {
      this.#paint(id);
    }
  }

  /** The face a key would currently render. Separated out so it is assertable. */
  face(settings: ChatUnreadSettings): ChatKeyFace {
    const count = this.#remote.unreadCount(settings.clientId);
    return {
      // `null` means no client for this binding — never an empty roster.
      connected: count !== null,
      count: count ?? 0,
      label: this.#label(settings),
    };
  }

  /**
   * The label ladder's top two rungs, which live here rather than in the
   * extension: the user's own override, then the plugin's last-known-good cache
   * of what the client called itself. Below those, the client's own ladder has
   * already run (domain → local part → account index → id stub).
   */
  #label(settings: ChatUnreadSettings): string {
    if (settings.label !== "") {
      return settings.label;
    }
    return this.#remote.labelOf(settings.clientId) ?? "Chat";
  }

  #paint(id: string): void {
    const entry = this.#keys.get(id);
    if (entry === undefined) {
      return;
    }
    void entry.action.setImage(svgToImageUri(renderChatKeySvg(this.face(entry.settings))));
  }
}
