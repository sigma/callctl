import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { currentInstance } from "../calendar/engine.js";
import { computeFace } from "../calendar/face.js";
import { renderFaceSvg } from "../calendar/render.js";
import type { CalendarService } from "../calendar/service.js";
import type { MeetingInstance } from "../calendar/types.js";
import { type NextMeetingSettings, parseKeySettings } from "../settings.js";

/** How often the render clock repaints every appeared key (§9). */
const RENDER_TICK_MS = 500;

/** One appeared Next-Meeting key: its live SDK handle plus its parsed settings. */
interface KeyEntry {
  action: KeyAction;
  settings: NextMeetingSettings;
}

/** Injectable side-effects (§7), kept out of the class so it stays vitest-testable. */
export interface NextMeetingDeps {
  now?: () => Date;
  /**
   * Host-delegated URL open (§7 tier 1) — the plugin wires
   * `streamDeck.system.openUrl`. Fire-and-forget: resolves when the request is
   * *sent to the host*, not when the browser opens.
   */
  openUrl?: (url: string) => Promise<void>;
  /** Structured log sink; the plugin wires `streamDeck.logger`. Never receives a URL. */
  log?: (message: string) => void;
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
 * The §8 escalation lives in {@link computeFace}/{@link renderFaceSvg}; this
 * class adds the §9 boundary tripwire (a confirming poll when the current
 * meeting ends) and the §7 press-to-open handler ({@link onKeyDown}). The open
 * itself is an injected {@link NextMeetingDeps.openUrl} so the class carries no
 * SDK singleton and stays fully unit-testable.
 */
export class NextMeetingAction extends SingletonAction {
  readonly #service: CalendarService;
  readonly #now: () => Date;
  readonly #openUrl: (url: string) => Promise<void>;
  readonly #log: (message: string) => void;
  readonly #keys = new Map<string, KeyEntry>();
  /**
   * Per-key `end` (ms) of the instance it last rendered — the boundary tripwire
   * (§9). When `now` passes it, that meeting ended: the key advances (via
   * {@link currentInstance}) and we force one confirming poll.
   */
  readonly #currentEnd = new Map<string, number>();
  #renderTimer: ReturnType<typeof setInterval> | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(uuid: string, service: CalendarService, deps: NextMeetingDeps = {}) {
    super();
    // A single class serving one UUID; set manifestId here as the other actions do.
    (this as { manifestId: string }).manifestId = uuid;
    this.#service = service;
    this.#now = deps.now ?? (() => new Date());
    // Default openUrl is a safe no-op — the plugin wires the real host open.
    this.#openUrl = deps.openUrl ?? (async () => {});
    this.#log = deps.log ?? (() => {});
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
    this.#currentEnd.delete(ev.action.id);
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

  /**
   * Press → open (§7 tier 1). Opens the surfaced event's target in the default
   * browser via the host-delegated {@link NextMeetingDeps.openUrl}:
   *
   * - **tier (a)** → the canonicalized `joinUrl` (§6.3), reconstructed & safe.
   * - **tier (b)** → the feed-derived calendar fallback (§6.4), never the
   *   event's untrusted `URL`.
   * - **no surfaced event** (Free / unconfigured / error / loading) → a safe
   *   no-op that never opens a stale URL: `showAlert` for a config gap,
   *   `showOk` between meetings.
   *
   * The open is **fire-and-forget** (`.catch` + log only) so a rejected request
   * never escapes the key handler (§7). Tier-2 browser-profile targeting is #61.
   */
  override onKeyDown(ev: KeyDownEvent): void {
    if (!ev.action.isKey()) return;
    const entry = this.#keys.get(ev.action.id);
    if (entry === undefined) return;
    const { settings } = entry;

    const snapshot = settings.feedId === "" ? undefined : this.#service.snapshot(settings.feedId);
    const current =
      snapshot === undefined
        ? undefined
        : currentInstance(snapshot.list, settings.offset, this.#now());

    if (current === undefined) {
      // Nothing surfaced: never open a stale/previous URL (§7). Nudge to setup
      // when the feed is missing; acknowledge an idle "Free" press otherwise.
      if (snapshot === undefined) void ev.action.showAlert();
      else void ev.action.showOk();
      return;
    }

    const target = this.#openTarget(current.candidate, settings.feedId);
    if (target === undefined) {
      // Tier-(b) event but no derivable fallback (unparseable feed origin) —
      // safe no-op, flag it rather than open nothing silently.
      void ev.action.showAlert();
      return;
    }
    // Fire-and-forget host open — resolves when *sent*, not when the browser
    // opens; a rejection is logged, never thrown out of the handler (§7).
    void this.#openUrl(target).catch((err) =>
      this.#log(
        `next-meeting: openUrl failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  /**
   * The URL a press should open for a surfaced event (§7): the canonicalized
   * `joinUrl` for tier (a), else the feed-derived calendar fallback for tier (b).
   */
  #openTarget(candidate: MeetingInstance["candidate"], feedId: string): string | undefined {
    if (candidate.tier === "a") return candidate.joinUrl;
    return this.#service.calendarFallback(feedId);
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
    const now = this.#now();

    // No such feed (empty or dangling feedId) ⇒ unconfigured face (§8).
    const snapshot = settings.feedId === "" ? undefined : this.#service.snapshot(settings.feedId);
    const list = snapshot?.list ?? [];

    // Meeting-boundary crossing (§9): if the instance we last rendered has now
    // ended, the key advances (currentInstance skips it below) — force one poll
    // to confirm the new head is real. `#currentEnd` gates it to a single fire.
    const prevEnd = this.#currentEnd.get(id);
    if (prevEnd !== undefined && now.getTime() >= prevEnd) {
      this.#currentEnd.delete(id);
      this.#forcePoll(id, settings.feedId);
    }
    const current = currentInstance(list, settings.offset, now);
    if (current !== undefined) this.#currentEnd.set(id, current.end.getTime());
    else this.#currentEnd.delete(id);

    const face = computeFace({
      configured: snapshot !== undefined,
      status: snapshot?.status ?? "loading",
      list,
      offset: settings.offset,
      now,
    });
    void action.setImage(renderFaceSvg(face));
  }
}
