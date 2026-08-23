import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ChatKeyFace, renderChatKeySvg } from "../chat/render.js";
import { type AppTarget, CHAT_URL } from "../open/app-open.js";
import type { ChatRemote } from "../remote/chat-remote.js";
import { type ChatUnreadSettings, parseChatUnreadSettings } from "../settings.js";

/** Injectable side-effects, kept out of the class so it stays vitest-testable. */
export interface ChatUnreadDeps {
  /**
   * Launch the installed Chat app in a configured profile — the plugin wires
   * `openChatApp` (`execFile`, no shell, and deliberately no `-n`). Rejects when
   * there is nothing to target or the launcher fails.
   */
  openApp?: (target: AppTarget) => Promise<void>;
  /**
   * Host-delegated URL open — the plugin wires `streamDeck.system.openUrl`. The
   * last resort when no profile is configured to launch into.
   */
  openUrl?: (url: string) => Promise<void>;
  /** Structured log sink; the plugin wires `streamDeck.logger`. */
  log?: (message: string) => void;
}

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
  readonly #deps: ChatUnreadDeps;
  readonly #keys = new Map<string, KeyEntry>();

  constructor(uuid: string, remote: ChatRemote, deps: ChatUnreadDeps = {}) {
    super();
    (this as { manifestId: string }).manifestId = uuid;
    this.#remote = remote;
    this.#deps = deps;

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
   * Press brings the Chat window to the front. **A dark key is never a dead
   * key**, so the two tiers cover both states the face can be in.
   *
   * Tier 1 — the bound client is attached: send `chat.raise` to **that** client,
   * so with two Chat windows open the right one comes forward.
   *
   * Tier 2 — nothing attached: launch the installed app ourselves, which is also
   * what fixes a key that is bound-but-absent.
   */
  override onKeyDown(ev: KeyDownEvent): void {
    const entry = this.#keys.get(ev.action.id);
    if (entry === undefined) {
      return;
    }
    if (this.#remote.raise(entry.settings.clientId)) {
      return;
    }
    void this.#launch(entry.settings);
  }

  /**
   * Tier 2. Targets the installed app by id in the configured profile, which is
   * a genuine focus rather than a second window. Anything that stops that —
   * Chat not installed as an app, no profile configured, a launcher failure —
   * degrades to a host-delegated tab rather than failing silently.
   */
  async #launch(settings: ChatUnreadSettings): Promise<void> {
    const { openApp, openUrl, log } = this.#deps;
    if (openApp !== undefined) {
      try {
        await openApp({ profile: settings.profile, appId: settings.appId });
        return;
      } catch (err) {
        log?.(`chat app launch failed, opening a tab instead: ${(err as Error).message}`);
      }
    }
    await openUrl?.(CHAT_URL);
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
