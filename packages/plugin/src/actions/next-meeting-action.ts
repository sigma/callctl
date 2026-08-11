import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import {
  applyDismissal,
  currentInstance,
  displayHorizon,
  isJoined,
  joinIdentity,
} from "../calendar/engine.js";
import { computeFace, msToNextVisibleChange } from "../calendar/face.js";
import { renderFaceSvg } from "../calendar/render.js";
import type { CalendarService } from "../calendar/service.js";
import type { MeetingInstance } from "../calendar/types.js";
import type { OpenTarget } from "../open/profile-open.js";
import { type NextMeetingSettings, parseKeySettings } from "../settings.js";

/**
 * Wrap an SVG document as a base64 `data:` URI for `KeyAction.setImage`. Although
 * the SDK types accept a bare `<svg>` string, the Stream Deck app does **not**
 * reliably render one passed verbatim (it is treated as a file path and silently
 * ignored, leaving the manifest's default icon on the key) — the base64
 * `data:image/svg+xml` form is the portable representation every app build
 * honors. `Buffer` (Node, the plugin runtime) handles the multi-byte glyphs the
 * faces use (`…`, `+`, accented titles) correctly.
 */
function svgToImageUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

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
   * `"gmeet:abc-def-ghi"`) or `null`. A windowed match holds the meeting as the
   * calm in-call face and ends the late flash. Defaults to always-`null`
   * (extension absent → the fixed §10 grace window is the only thing that ends
   * the flash, calming it to steady `overdue`).
   */
  joinedKey?: () => string | null;
}

/**
 * The `NextMeetingAction` (§2) — the plugin's first timer-driven, title-rendering
 * action. It owns the **render clock** (contract #2: a per-key self-rescheduling
 * timer that repaints each appeared key off the cached event set *exactly* when
 * that key's face next changes, so the imminent/late flash can't alias a fixed
 * tick) and the **feed-poll clock** (a self-rescheduling timer at
 * `pollIntervalMinutes`, §9), plus the forced startup poll when a key appears or
 * its feed changes.
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
  /**
   * §10 durable join memory: the {@link joinIdentity} of every occurrence the
   * extension has reported us in-call for this session. Grown from the *live*
   * `joinedKey` on every render/press, it outlives leaving the call — so a
   * meeting you joined and then left stays held (calm, never re-flashing late)
   * until its `DTEND`, rather than resuming the late flash the instant the live
   * signal clears.
   */
  readonly #joinedOccurrences = new Set<string>();
  /**
   * Per-key render clock (contract #2): one self-rescheduling `setTimeout` per
   * appeared key, fired exactly when that key's face next changes
   * ({@link msToNextVisibleChange}) instead of on a shared fixed tick. Keyed by
   * action id; started on appear, re-derived on every paint, cleared on disappear.
   */
  readonly #renderTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    // fixed §10 grace window ends the late flash (calming it to steady overdue).
    this.#joinedKey = deps.joinedKey ?? (() => null);
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    const settings = parseKeySettings(ev.payload.settings);
    this.#keys.set(ev.action.id, { action: ev.action, settings });
    this.#scheduleNextPoll();
    // Forced startup poll (§9): fetch this feed now, repaint as soon as it lands.
    this.#forcePoll(ev.action.id, settings.feedId);
    // First paint arms this key's render clock (contract #2); it self-reschedules.
    this.#paintKey(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const timer = this.#renderTimers.get(ev.action.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#renderTimers.delete(ev.action.id);
    }
    this.#keys.delete(ev.action.id);
    this.#currentEnd.delete(ev.action.id);
    if (this.#keys.size === 0) this.#stopPollClock();
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
   * browser via the host-delegated {@link NextMeetingDeps.openUrl}, matching what
   * the key's face shows:
   *
   * - **counting down** (event within the display horizon) →
   *   - **tier (a)** → the canonicalized `joinUrl` (§6.3), reconstructed & safe.
   *   - **tier (b)** → the feed-derived calendar fallback (§6.4), never the
   *     event's untrusted `URL`.
   * - **"Free"** (a next event exists but is beyond the horizon) → the calendar
   *   home itself (§6.4), *not* the far-off meeting's join link — opening a call
   *   you are not near makes no sense; the calendar is the useful destination.
   * - **nothing surfaced** (idle Free / unconfigured / error / loading) → a safe
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
    if (snapshot === undefined) {
      // No feed configured/known: never open a stale URL — nudge to setup (§7).
      void ev.action.showAlert();
      return;
    }

    // Classify the *surfaced* (post-§10-dismissal) event exactly as the face does,
    // so the press target matches what the key shows. A press is not join-proof,
    // so it never itself dismisses. As on the render path, the live-join fold runs
    // on the *pre*-dismissal list — that ordering is what lets a non-attending
    // meeting you joined anyway be held, and so rescued (§5.1, #96).
    this.#recordLiveJoins(snapshot.list, now);
    const horizon = displayHorizon(
      applyDismissal(snapshot.list, this.#joinedOccurrences),
      settings.offset,
      now,
      settings.horizonMinutes * 60 * 1000,
    );

    if (horizon.kind === "none") {
      // Between meetings, nothing surfaced — acknowledge the idle "Free" press (§7).
      void ev.action.showOk();
      return;
    }

    // "Free" (beyond horizon) opens the calendar home; a live countdown opens the
    // event's join link (tier a) or its own calendar fallback (tier b).
    const target =
      horizon.kind === "beyond"
        ? this.#service.calendarFallback(settings.feedId)
        : this.#openTarget(horizon.instance.candidate, settings.feedId);
    if (target === undefined) {
      // No derivable calendar fallback (unparseable feed origin) — safe no-op,
      // flag it rather than open nothing silently.
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

  #stopPollClock(): void {
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

  /**
   * (Re)arm a key's render clock (contract #2): schedule its next repaint exactly
   * `delay` ms out (already clamped to `[1, MAX_MS]` by
   * {@link msToNextVisibleChange}). Clears any pending timer first, so every paint
   * — tick, forced poll, or settings change — re-derives the cadence rather than
   * stacking timers.
   */
  #scheduleNextPaint(id: string, delay: number): void {
    const existing = this.#renderTimers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#renderTimers.delete(id);
      this.#paintKey(id);
    }, delay);
    this.#renderTimers.set(id, timer);
  }

  #paintKey(id: string): void {
    const entry = this.#keys.get(id);
    if (entry === undefined) return;
    const { action, settings } = entry;
    const now = this.#now();

    // No such feed (empty or dangling feedId) ⇒ unconfigured face (§8).
    const snapshot = settings.feedId === "" ? undefined : this.#service.snapshot(settings.feedId);
    // Grow the durable join memory from the live signal, then apply §10 dismissal
    // before both the boundary tripwire and the face: a held (joined this session)
    // meeting stays until its DTEND and shows the calm in-call face, and any
    // non-held meeting skipped before it drops out so the key advances. A
    // never-joined late meeting is *not* dropped — it keeps surfacing (its flash
    // calming to steady overdue) until its own DTEND, while a non-attending one
    // (§5.1) drops unless held. **The order is load-bearing**: the fold must see
    // the *pre*-dismissal list, or a declined-then-joined meeting could never
    // enter the held set that rescues it (§5.1, #96).
    this.#recordLiveJoins(snapshot?.list ?? [], now);
    const list = applyDismissal(snapshot?.list ?? [], this.#joinedOccurrences);

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

    const faceInput = {
      configured: snapshot !== undefined,
      status: snapshot?.status ?? ("loading" as const),
      list,
      offset: settings.offset,
      now,
      horizonMs: settings.horizonMinutes * 60 * 1000,
      heldKeys: this.#joinedOccurrences,
    };
    // The per-feed border (#78) is feed identity, threaded orthogonally to the
    // face. An empty/dangling feed has none, so its unconfigured face stays bare.
    const borderColor =
      settings.feedId === "" ? undefined : this.#service.borderColor(settings.feedId);
    void action.setImage(svgToImageUri(renderFaceSvg(computeFace(faceInput), borderColor)));
    // Re-arm the render clock off the *same* inputs we just painted: repaint
    // exactly when this face next moves (contract #2), never on a fixed tick.
    this.#scheduleNextPaint(id, msToNextVisibleChange(faceInput));
  }

  /**
   * Fold the *live* `joinedKey` into the durable §10 join memory: mark every
   * started occurrence in `list` the extension currently reports us in-call for
   * (see {@link isJoined}) as held ({@link joinIdentity}). Idempotent and
   * additive — the identity persists after the live signal clears on leave, so
   * the meeting never re-flashes late.
   */
  #recordLiveJoins(list: MeetingInstance[], now: Date): void {
    const key = this.#joinedKey();
    if (key === null) return;
    for (const inst of list) {
      if (isJoined(inst, key, now)) {
        const id = joinIdentity(inst);
        if (id !== null) this.#joinedOccurrences.add(id);
      }
    }
  }
}
