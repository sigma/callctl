import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { applyDismissal, currentInstance } from "../calendar/engine.js";
import { computeFace } from "../calendar/face.js";
import { renderFaceSvg } from "../calendar/render.js";
import type { CalendarService } from "../calendar/service.js";
import type { MeetingInstance } from "../calendar/types.js";
import type { OpenTarget } from "../open/profile-open.js";
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
  /**
   * Configured profile-targeted open (§7 tier 2) — the plugin wires
   * `openWithProfile` (`child_process.execFile`, no shell). Fire-and-forget like
   * {@link openUrl}; a rejection means the launch failed (bad binary, OS not in
   * the table, non-zero exit) and the handler degrades to tier 1 + `showAlert`.
   */
  openWith?: (url: string, target: OpenTarget) => Promise<void>;
  /** Structured log sink; the plugin wires `streamDeck.logger`. Never receives a URL. */
  log?: (message: string) => void;
  /**
   * Optional §10 join-detection reader — the plugin wires `MeetRemote.joinedKey`.
   * Returns the provider-namespaced code of the call you are *in* (e.g.
   * `"gmeet:abc-def-ghi"`) or `null`. A windowed match dismisses the late state
   * and advances the key. Defaults to always-`null` (extension absent → the
   * §10 grace-timer fallback is the only dismissal path, exactly as specified).
   */
  joinedKey?: () => string | null;
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
  readonly #openWith: (url: string, target: OpenTarget) => Promise<void>;
  readonly #log: (message: string) => void;
  readonly #joinedKey: () => string | null;
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
    // Default openWith rejects so an unwired tier-2 open cleanly degrades to tier 1.
    this.#openWith = deps.openWith ?? (async () => Promise.reject(new Error("openWith not wired")));
    this.#log = deps.log ?? (() => {});
    // No dep ⇒ the extension is absent: join-proof never fires and only the
    // §10 grace-timer fallback dismisses the late state.
    this.#joinedKey = deps.joinedKey ?? (() => null);
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
   * never escapes the key handler (§7). When the feed carries an `open` config
   * (§3), the press instead targets that browser profile (§7 tier 2, see
   * {@link dispatchOpen}), degrading to tier 1 if the launch fails.
   */
  override onKeyDown(ev: KeyDownEvent): void {
    if (!ev.action.isKey()) return;
    const entry = this.#keys.get(ev.action.id);
    if (entry === undefined) return;
    const { settings } = entry;

    const now = this.#now();
    const snapshot = settings.feedId === "" ? undefined : this.#service.snapshot(settings.feedId);
    // Press opens the *surfaced* (post-§10-dismissal) event, never a dismissed
    // late one. A press is not join-proof, so it never itself dismisses.
    const current =
      snapshot === undefined
        ? undefined
        : currentInstance(
            applyDismissal(snapshot.list, now, settings.graceMinutes, this.#joinedKey()),
            settings.offset,
            now,
          );

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
    this.#dispatchOpen(target, settings.feedId, ev.action);
  }

  /**
   * The URL a press should open for a surfaced event (§7): the canonicalized
   * `joinUrl` for tier (a), else the feed-derived calendar fallback for tier (b).
   */
  #openTarget(candidate: MeetingInstance["candidate"], feedId: string): string | undefined {
    if (candidate.tier === "a") return candidate.joinUrl;
    return this.#service.calendarFallback(feedId);
  }

  /**
   * Open `url` for a press (§7). If the feed has an `open` config (§3), target
   * that browser profile via {@link NextMeetingDeps.openWith} (tier 2); a launch
   * failure degrades to tier 1 + `showAlert` + log. Otherwise open directly in
   * the default browser (tier 1). Both tiers are fire-and-forget.
   */
  #dispatchOpen(url: string, feedId: string, action: KeyAction): void {
    const target = this.#service.openConfig(feedId);
    if (target === undefined) {
      this.#tier1Open(url);
      return;
    }
    // Tier 2: exec into the configured browser profile. Only a spawn-level
    // failure is detectable (fire-and-forget); on any rejection, degrade to the
    // default browser and flag it so the user notices the profile didn't take.
    void this.#openWith(url, target).catch((err) => {
      this.#log(
        `next-meeting: profile open failed (${target.browser}/${target.profile}), ` +
          `falling back to default browser: ${err instanceof Error ? err.message : String(err)}`,
      );
      void action.showAlert();
      this.#tier1Open(url);
    });
  }

  /**
   * Tier-1 host-delegated open (§7): resolves when *sent* to the host, not when
   * the browser opens. Fire-and-forget — a rejection is logged, never thrown out
   * of the key handler.
   */
  #tier1Open(url: string): void {
    void this.#openUrl(url).catch((err) =>
      this.#log(
        `next-meeting: openUrl failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
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
    // Apply §10 late-state dismissal before both the boundary tripwire and the
    // face: a joined (or grace-elapsed) meeting drops out of the view here, so
    // the key advances to the next event and stops flashing late.
    const list = applyDismissal(
      snapshot?.list ?? [],
      now,
      settings.graceMinutes,
      this.#joinedKey(),
    );

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
