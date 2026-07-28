import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarService } from "../calendar/service.js";
import type { FeedSnapshot, MeetingInstance } from "../calendar/types.js";
import type { OpenTarget } from "../open/profile-open.js";
import { NextMeetingAction } from "./next-meeting-action.js";

/** A tier-(a) instance spanning `[startMs, endMs]` (absolute epoch ms). */
function instance(
  startMs: number,
  endMs: number,
  over: Partial<MeetingInstance> = {},
): MeetingInstance {
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    allDay: false,
    title: "Sync",
    sourceFeedId: "work",
    candidate: {
      tier: "a",
      provider: "gmeet",
      code: "gmeet:abc-def-ghi",
      joinUrl: "https://meet.google.com/abc-def-ghi",
    },
    ...over,
  };
}

/** A minimal fake {@link CalendarService} whose snapshot/fallback are settable per test. */
function fakeService(opts: {
  snapshot?: FeedSnapshot;
  fallback?: string;
  open?: OpenTarget;
}): CalendarService & { poll: ReturnType<typeof vi.fn> } {
  const svc = {
    pollIntervalMinutes: 15,
    snapshot: vi.fn((feedId: string) => (feedId === "work" ? opts.snapshot : undefined)),
    poll: vi.fn(async () => {}),
    pollAll: vi.fn(async () => {}),
    calendarFallback: vi.fn(() => opts.fallback),
    openConfig: vi.fn(() => opts.open),
  };
  return svc as unknown as CalendarService & { poll: ReturnType<typeof vi.fn> };
}

/** A fake SDK KeyAction capturing setImage / showOk / showAlert. */
function fakeKey(id: string) {
  return {
    id,
    isKey: () => true,
    setImage: vi.fn(async () => {}),
    showOk: vi.fn(async () => {}),
    showAlert: vi.fn(async () => {}),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const appearEv = (action: unknown, settings: Record<string, unknown>): any => ({
  action,
  payload: { settings },
});
// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const keyDownEv = (action: unknown): any => ({ action });
// biome-ignore lint/suspicious/noExplicitAny: fake SDK events are structurally typed for the handlers.
const disappearEv = (action: { id: string }): any => ({ action });

describe("NextMeetingAction — meeting-boundary advance (§9)", () => {
  let clock = 0;
  const now = () => new Date(clock);

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces one confirming poll when the current meeting ends", () => {
    // A meeting ending at t=1000; the next runs later.
    const snapshot: FeedSnapshot = {
      status: "ok",
      list: [
        instance(-60_000, 1_000, { title: "Running" }),
        instance(30_000, 60_000, { title: "Next" }),
      ],
    };
    const service = fakeService({ snapshot });
    const action = new NextMeetingAction("uuid", service, { now });
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
    // Startup forced poll (§9) fired exactly once on appear.
    expect(service.poll).toHaveBeenCalledTimes(1);

    // A render tick still before the boundary: no new poll.
    clock = 500;
    vi.advanceTimersByTime(500);
    expect(service.poll).toHaveBeenCalledTimes(1);

    // Cross the boundary (now ≥ the running meeting's end) and tick again.
    clock = 1_500;
    vi.advanceTimersByTime(500);
    expect(service.poll).toHaveBeenCalledTimes(2);
    expect(service.poll).toHaveBeenLastCalledWith("work", expect.any(Date));
  });

  it("does not re-poll on every tick after a single boundary crossing", () => {
    const snapshot: FeedSnapshot = {
      status: "ok",
      list: [
        instance(-60_000, 1_000, { title: "Running" }),
        instance(30_000, 60_000, { title: "Next" }),
      ],
    };
    const service = fakeService({ snapshot });
    const action = new NextMeetingAction("uuid", service, { now });
    action.onWillAppear(appearEv(fakeKey("k1"), { feedId: "work", offset: 0 }));

    clock = 1_500;
    vi.advanceTimersByTime(500); // crossing → poll #2
    clock = 2_000;
    vi.advanceTimersByTime(500); // next head is future → no further poll
    clock = 2_500;
    vi.advanceTimersByTime(500);
    expect(service.poll).toHaveBeenCalledTimes(2);
  });
});

describe("NextMeetingAction — press → open (§7)", () => {
  const NOW = 1_000;
  const now = () => new Date(NOW);
  /** A currently-surfaced instance (started, still running) at `NOW`. */
  const surfaced = (over: Partial<MeetingInstance> = {}) => instance(0, 60_000, over);

  /** Appear a key, run `body`, then disappear it so the render interval is cleared. */
  function withKey(
    service: CalendarService,
    deps: {
      openUrl?: (u: string) => Promise<void>;
      openWith?: (u: string, t: OpenTarget) => Promise<void>;
      log?: (m: string) => void;
      joinedKey?: () => string | null;
    },
    settings: Record<string, unknown>,
    body: (action: NextMeetingAction, key: ReturnType<typeof fakeKey>) => void,
  ): void {
    vi.useFakeTimers();
    try {
      const action = new NextMeetingAction("uuid", service, { now, ...deps });
      const key = fakeKey("k1");
      action.onWillAppear(appearEv(key, settings));
      body(action, key);
      action.onWillDisappear(disappearEv(key));
    } finally {
      vi.useRealTimers();
    }
  }

  it("opens the canonicalized joinUrl for a tier-(a) event", () => {
    const service = fakeService({ snapshot: { status: "ok", list: [surfaced()] } });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).toHaveBeenCalledWith("https://meet.google.com/abc-def-ghi");
      expect(key.showAlert).not.toHaveBeenCalled();
    });
  });

  it("opens the feed-derived calendar fallback for a tier-(b) event", () => {
    const service = fakeService({
      snapshot: { status: "ok", list: [surfaced({ candidate: { tier: "b" } })] },
      fallback: "https://calendar.google.com",
    });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).toHaveBeenCalledWith("https://calendar.google.com");
      expect(service.calendarFallback).toHaveBeenCalledWith("work");
    });
  });

  it("is a safe no-op (showAlert, no open) for a tier-(b) event with no derivable fallback", () => {
    const service = fakeService({
      snapshot: { status: "ok", list: [surfaced({ candidate: { tier: "b" } })] },
      fallback: undefined,
    });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).not.toHaveBeenCalled();
      expect(key.showAlert).toHaveBeenCalled();
    });
  });

  it("opens the calendar home, not the join link, for a 'Free' beyond-horizon event", () => {
    // A tier-(a) event two days out — past the default 24h horizon, so the key
    // reads "Free". Pressing it opens the calendar, never the far-off join link.
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    const service = fakeService({
      snapshot: { status: "ok", list: [instance(NOW + twoDays, NOW + twoDays + 60_000)] },
      fallback: "https://calendar.google.com",
    });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).toHaveBeenCalledWith("https://calendar.google.com");
      expect(openUrl).not.toHaveBeenCalledWith("https://meet.google.com/abc-def-ghi");
      expect(service.calendarFallback).toHaveBeenCalledWith("work");
      expect(key.showAlert).not.toHaveBeenCalled();
    });
  });

  it("is a safe no-op for a 'Free' beyond-horizon event with no derivable calendar", () => {
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    const service = fakeService({
      snapshot: { status: "ok", list: [instance(NOW + twoDays, NOW + twoDays + 60_000)] },
      fallback: undefined,
    });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).not.toHaveBeenCalled();
      expect(key.showAlert).toHaveBeenCalled();
    });
  });

  it("acknowledges an idle Free press without opening anything", () => {
    const service = fakeService({ snapshot: { status: "ok", list: [] } });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).not.toHaveBeenCalled();
      expect(key.showOk).toHaveBeenCalled();
    });
  });

  it("nudges to setup (showAlert, no open) when the feed is unconfigured", () => {
    const service = fakeService({ snapshot: undefined });
    const openUrl = vi.fn(async () => {});
    withKey(service, { openUrl }, { feedId: "", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).not.toHaveBeenCalled();
      expect(key.showAlert).toHaveBeenCalled();
    });
  });

  it("opens via the configured browser profile when the feed has an open config (tier 2)", () => {
    const open: OpenTarget = { browser: "chrome", profile: "Work" };
    const service = fakeService({ snapshot: { status: "ok", list: [surfaced()] }, open });
    const openUrl = vi.fn(async () => {});
    const openWith = vi.fn(async () => {});
    withKey(service, { openUrl, openWith }, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openWith).toHaveBeenCalledWith("https://meet.google.com/abc-def-ghi", open);
      // Tier 2 handled it — no default-browser open, no alert.
      expect(openUrl).not.toHaveBeenCalled();
      expect(key.showAlert).not.toHaveBeenCalled();
    });
  });

  it("degrades a failed profile open to tier 1 + showAlert + log (§7)", async () => {
    const open: OpenTarget = { browser: "brave", profile: "Bad" };
    const service = fakeService({ snapshot: { status: "ok", list: [surfaced()] }, open });
    const openUrl = vi.fn(async () => {});
    const openWith = vi.fn(async () => {
      throw new Error("ENOENT: no such browser");
    });
    const log = vi.fn();
    const action = new NextMeetingAction("uuid", service, { now, openUrl, openWith, log });
    const key = fakeKey("k1");
    vi.useFakeTimers();
    try {
      action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
      expect(() => action.onKeyDown(keyDownEv(key))).not.toThrow();
      // Let the rejected openWith and the tier-1 fallback microtasks flush.
      await Promise.resolve();
      await Promise.resolve();
      expect(openUrl).toHaveBeenCalledWith("https://meet.google.com/abc-def-ghi");
      expect(key.showAlert).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
      action.onWillDisappear(disappearEv(key));
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances past a joined meeting (§10): a press opens the next event, not the joined one", () => {
    // Two live meetings; the first is the one we've joined (join proof matches
    // its code), so the surfaced event a press opens is the *second*.
    const joined = instance(-5_000, 55_000, {
      title: "Joined",
      candidate: {
        tier: "a",
        provider: "gmeet",
        code: "gmeet:abc-def-ghi",
        joinUrl: "https://meet.google.com/abc-def-ghi",
      },
    });
    const next = instance(10_000, 70_000, {
      title: "Next",
      candidate: {
        tier: "a",
        provider: "gmeet",
        code: "gmeet:next-meet-ing",
        joinUrl: "https://meet.google.com/next-meet-ing",
      },
    });
    const service = fakeService({ snapshot: { status: "ok", list: [joined, next] } });
    const openUrl = vi.fn(async () => {});
    const deps = { openUrl, joinedKey: () => "gmeet:abc-def-ghi" };
    withKey(service, deps, { feedId: "work", offset: 0 }, (action, key) => {
      action.onKeyDown(keyDownEv(key));
      expect(openUrl).toHaveBeenCalledWith("https://meet.google.com/next-meet-ing");
    });
  });

  it("is fire-and-forget: a rejected open is logged, never thrown", async () => {
    const service = fakeService({ snapshot: { status: "ok", list: [surfaced()] } });
    const openUrl = vi.fn(async () => {
      throw new Error("host refused");
    });
    const log = vi.fn();
    const action = new NextMeetingAction("uuid", service, { now, openUrl, log });
    const key = fakeKey("k1");
    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
    // Synchronous handler must not throw even though the open rejects.
    expect(() => action.onKeyDown(keyDownEv(key))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("host refused"));
    action.onWillDisappear(disappearEv(key));
  });
});

describe("NextMeetingAction — setImage encoding", () => {
  const now = () => new Date(0);

  /** Decode the SVG markup from the last `setImage` call (the fake types 0 args). */
  function lastImage(key: ReturnType<typeof fakeKey>): string {
    const uri = String((key.setImage.mock.calls.at(-1) as unknown[] | undefined)?.[0]);
    // The Stream Deck app renders SVG only via a base64 data URI, not a bare
    // `<svg>` string — assert we ship that form and recover the markup.
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    return Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  }

  it("paints the key with a base64 data: URI wrapping the rendered SVG", () => {
    const service = fakeService({
      snapshot: { status: "ok", list: [instance(30_000, 60_000, { title: "Sync" })] },
    });
    const action = new NextMeetingAction("uuid", service, { now });
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));

    expect(key.setImage).toHaveBeenCalled();
    const svg = lastImage(key);
    expect(svg).toContain("<svg");
    expect(svg).toContain("Sync");
    expect(svg).toContain("00:30"); // 30 s countdown
    action.onWillDisappear(disappearEv(key));
  });

  it("round-trips multi-byte glyphs (the loading ellipsis) through base64", () => {
    const service = fakeService({ snapshot: { status: "loading", list: [] } });
    const action = new NextMeetingAction("uuid", service, { now });
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));

    const svg = lastImage(key);
    expect(svg).toContain("…");
    action.onWillDisappear(disappearEv(key));
  });
});
