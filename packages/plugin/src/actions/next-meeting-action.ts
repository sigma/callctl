import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { computeFace } from "../calendar/face.js";
import { renderFaceSvg } from "../calendar/render.js";
import type { CalendarService } from "../calendar/service.js";
import { type NextMeetingSettings, parseKeySettings } from "../settings.js";

/** How often the render clock repaints every appeared key (§9). */
const RENDER_TICK_MS = 500;

/** One appeared Next-Meeting key: its live SDK handle plus its parsed settings. */
interface KeyEntry {
  action: KeyAction;
  settings: NextMeetingSettings;
}

/**
 * The `NextMeetingAction` (§2) — the plugin's first timer-driven, title-rendering
 * action. It owns the **render clock** (a 500 ms local tick that repaints every
 * appeared key off the cached event set, §9) and the **feed-poll clock** (a
 * self-rescheduling timer at `pollIntervalMinutes`, §9), plus the forced startup
 * poll when a key appears or its feed changes.
 *
 * All the decision logic lives outside this class — {@link CalendarService}
 * (fetch/parse/select/cache), {@link computeFace} (which face, §8), and
 * {@link renderFaceSvg} (how it's drawn) are pure and vitest-tested. This class
 * is only the SDK wiring: timers, settings, and `setImage` (mirrors the
 * `MeetRemote` split called for in #58).
 *
 * Scope note (#58): baseline non-escalating display only. Press-to-open,
 * escalation colours, blink/flash and boundary advance are #59 — hence no
 * `onKeyDown` here yet (a press is currently a no-op).
 */
export class NextMeetingAction extends SingletonAction {
  readonly #service: CalendarService;
  readonly #now: () => Date;
  readonly #keys = new Map<string, KeyEntry>();
  #renderTimer: ReturnType<typeof setInterval> | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(uuid: string, service: CalendarService, opts: { now?: () => Date } = {}) {
    super();
    // A single class serving one UUID; set manifestId here as the other actions do.
    (this as { manifestId: string }).manifestId = uuid;
    this.#service = service;
    this.#now = opts.now ?? (() => new Date());
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    const settings = parseKeySettings(ev.payload.settings);
    this.#keys.set(ev.action.id, { action: ev.action, settings });
    this.#startClocks();
    // Forced startup poll (§9): fetch this feed now, repaint as soon as it lands.
    this.#forcePoll(ev.action.id, settings.feedId);
    this.#paintKey(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.#keys.delete(ev.action.id);
    if (this.#keys.size === 0) this.#stopClocks();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
    if (!ev.action.isKey()) return;
    const next = parseKeySettings(ev.payload.settings);
    const prev = this.#keys.get(ev.action.id);
    this.#keys.set(ev.action.id, { action: ev.action, settings: next });
    // A changed feed is a forced-poll trigger (§9 "config URL changed").
    if (prev?.settings.feedId !== next.feedId) this.#forcePoll(ev.action.id, next.feedId);
    this.#paintKey(ev.action.id);
  }

  // ---- clocks ------------------------------------------------------------

  #startClocks(): void {
    if (this.#renderTimer === undefined) {
      this.#renderTimer = setInterval(() => this.#paintAll(), RENDER_TICK_MS);
    }
    this.#scheduleNextPoll();
  }

  #stopClocks(): void {
    if (this.#renderTimer !== undefined) {
      clearInterval(this.#renderTimer);
      this.#renderTimer = undefined;
    }
    if (this.#pollTimer !== undefined) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }

  /**
   * The feed-poll clock. Self-reschedules with `setTimeout` (rather than a fixed
   * `setInterval`) so a changed `pollIntervalMinutes` is picked up on the next
   * cycle without a restart.
   */
  #scheduleNextPoll(): void {
    if (this.#pollTimer !== undefined) return;
    const delay = this.#service.pollIntervalMinutes * 60 * 1000;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#pollActiveFeeds().finally(() => {
        if (this.#keys.size > 0) this.#scheduleNextPoll();
      });
    }, delay);
  }

  /** Poll every feed some appeared key is tracking, then repaint. */
  async #pollActiveFeeds(): Promise<void> {
    const now = this.#now();
    const feedIds = new Set<string>();
    for (const { settings } of this.#keys.values()) {
      if (settings.feedId !== "") feedIds.add(settings.feedId);
    }
    await Promise.all([...feedIds].map((id) => this.#service.poll(id, now)));
    this.#paintAll();
  }

  /** Force a single feed poll (startup / feed-changed) and repaint the key when it lands. */
  #forcePoll(id: string, feedId: string): void {
    if (feedId === "") return;
    void this.#service.poll(feedId, this.#now()).finally(() => this.#paintKey(id));
  }

  // ---- painting ----------------------------------------------------------

  #paintAll(): void {
    for (const id of this.#keys.keys()) this.#paintKey(id);
  }

  #paintKey(id: string): void {
    const entry = this.#keys.get(id);
    if (entry === undefined) return;
    const { action, settings } = entry;

    // No such feed (empty or dangling feedId) ⇒ unconfigured face (§8).
    const snapshot = settings.feedId === "" ? undefined : this.#service.snapshot(settings.feedId);
    const face = computeFace({
      configured: snapshot !== undefined,
      status: snapshot?.status ?? "loading",
      list: snapshot?.list ?? [],
      offset: settings.offset,
      now: this.#now(),
    });
    void action.setImage(renderFaceSvg(face));
  }
}
