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
    attending: true,
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
  borderColor?: string;
}): CalendarService & { poll: ReturnType<typeof vi.fn> } {
  const svc = {
    pollIntervalMinutes: 15,
    snapshot: vi.fn((feedId: string) => (feedId === "work" ? opts.snapshot : undefined)),
    poll: vi.fn(async () => {}),
    pollAll: vi.fn(async () => {}),
    calendarFallback: vi.fn(() => opts.fallback),
    openConfig: vi.fn(() => opts.open),
    borderColor: vi.fn((feedId: string) => (feedId === "work" ? opts.borderColor : undefined)),
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

  it("keeps a joined meeting surfaced (§10): a press re-opens it, not the next one", () => {
    // Two live meetings; the first is the one we've joined (join proof matches
    // its code). It stays current until its end, so offset 0 still surfaces it
    // and a press re-opens the *joined* meeting, not the second.
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
      expect(openUrl).toHaveBeenCalledWith("https://meet.google.com/abc-def-ghi");
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

describe("NextMeetingAction — per-key render clock (contract #2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An imminent countdown: starts 25 s out (imminent, gently blinking), +30m long. */
  const imminentSnapshot = (): FeedSnapshot => ({
    status: "ok",
    list: [instance(25_000, 25_000 + 30 * 60_000, { title: "Sync" })],
  });

  it("arms a per-key render timer on appear and clears it on disappear", () => {
    // Default now → the mocked system clock, so the self-rescheduling timers fire
    // against the same time base we advance.
    const action = new NextMeetingAction("uuid", fakeService({ snapshot: imminentSnapshot() }));
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
    expect(key.setImage).toHaveBeenCalled(); // the appear paint
    expect(vi.getTimerCount()).toBeGreaterThan(0); // render + poll clocks armed

    vi.advanceTimersByTime(2_000);
    const paintedWhileAppeared = key.setImage.mock.calls.length;
    expect(paintedWhileAppeared).toBeGreaterThan(1); // the per-key clock repainted

    action.onWillDisappear(disappearEv(key));
    expect(vi.getTimerCount()).toBe(0); // both render and poll clocks cleared

    vi.advanceTimersByTime(5_000);
    expect(key.setImage.mock.calls.length).toBe(paintedWhileAppeared); // no orphan repaints
  });

  it("threads the feed's resolved border color into the painted image (#78)", () => {
    // Decode the base64 data: URI of the first setImage call back to SVG markup.
    // The fake types setImage with 0 args, so cast the call tuple to read arg 0.
    const firstImage = (key: ReturnType<typeof fakeKey>): string => {
      const uri = String((key.setImage.mock.calls.at(0) as unknown[] | undefined)?.[0]);
      return Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString(
        "utf8",
      );
    };

    const bordered = fakeService({ snapshot: imminentSnapshot(), borderColor: "#14c8b0" });
    const key = fakeKey("k1");
    const action = new NextMeetingAction("uuid", bordered);
    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
    expect(firstImage(key)).toContain('stroke="#14c8b0"');
    action.onWillDisappear(disappearEv(key));

    // A feed with no color paints no border — today's exact look.
    const bare = fakeService({ snapshot: imminentSnapshot() });
    const key2 = fakeKey("k2");
    const action2 = new NextMeetingAction("uuid", bare);
    action2.onWillAppear(appearEv(key2, { feedId: "work", offset: 0 }));
    expect(firstImage(key2)).not.toContain("stroke=");
    action2.onWillDisappear(disappearEv(key2));
  });

  it("re-derives the render clock on a settings change without stacking timers", () => {
    const snapshot: FeedSnapshot = {
      status: "ok",
      list: [instance(25_000, 25_000 + 30 * 60_000), instance(40_000, 40_000 + 30 * 60_000)],
    };
    const action = new NextMeetingAction("uuid", fakeService({ snapshot }));
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
    expect(vi.getTimerCount()).toBe(2); // one render timer + one poll timer
    const before = key.setImage.mock.calls.length;

    action.onDidReceiveSettings(appearEv(key, { feedId: "work", offset: 1 }));
    expect(key.setImage.mock.calls.length).toBeGreaterThan(before); // immediate repaint
    expect(vi.getTimerCount()).toBe(2); // render timer replaced, not stacked

    action.onWillDisappear(disappearEv(key));
  });

  it("repaints exactly on blink/second edges through the imminent window (no stutter)", () => {
    // The regression guard for the "stuck for a frame every few frames" stutter:
    // with a fixed 500 ms tick the 600 ms blink aliased; the per-key clock instead
    // fires *on* each blink/second edge, so every repaint lands on the grid.
    const instants: number[] = [];
    const key = {
      ...fakeKey("k1"),
      setImage: vi.fn(async () => {
        instants.push(Date.now()); // mocked clock → the exact instant this paint ran
      }),
    };
    const action = new NextMeetingAction("uuid", fakeService({ snapshot: imminentSnapshot() }));

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 }));
    vi.advanceTimersByTime(24_000); // stay strictly inside the imminent window
    action.onWillDisappear(disappearEv(key));

    for (const t of instants) {
      if (t === 0) continue; // the appear / forced-poll paints at t=0
      // 600 ms = imminent blink half-period; 1000 ms = the MM:SS second edge.
      expect(t % 600 === 0 || t % 1000 === 0).toBe(true);
    }
    // Blink edges (not only whole seconds) actually drove repaints.
    expect(instants.some((t) => t % 600 === 0 && t % 1000 !== 0)).toBe(true);
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

  it("holds the calm in-call face after leaving a joined meeting, never re-flashing (§10)", () => {
    // Started 20m ago (well past the 5m grace window), still running: unjoined this would be
    // the red overdue state. Join, then leave — the live signal clears but the
    // durable hold keeps the teal in-call face.
    const joined = instance(-20 * 60_000, 40 * 60_000, { title: "Sync" });
    const service = fakeService({ snapshot: { status: "ok", list: [joined] } });
    let live: string | null = "gmeet:abc-def-ghi";
    const action = new NextMeetingAction("uuid", service, { now, joinedKey: () => live });
    const key = fakeKey("k1");

    action.onWillAppear(appearEv(key, { feedId: "work", offset: 0 })); // records the live join
    expect(lastImage(key)).toContain("#0b2b30"); // teal in-call field while joined

    live = null; // leave the call
    action.onDidReceiveSettings(appearEv(key, { feedId: "work", offset: 0 })); // repaint
    const svg = lastImage(key);
    expect(svg).toContain("#0b2b30"); // still the calm teal in-call face
    expect(svg).not.toContain("#ff5c50"); // never the red late/overdue flash
    action.onWillDisappear(disappearEv(key));
  });

  it("rescues a non-attending meeting you joined anyway, and only then (§5.1)", () => {
    // Pins the load-bearing ordering: the live-join fold runs on the
    // *pre*-dismissal list, so a declined meeting can still enter the held set —
    // the one door back in. Without the join it is simply dropped.
    const declined = instance(-5 * 60_000, 25 * 60_000, { attending: false });
    const service = fakeService({ snapshot: { status: "ok", list: [declined] } });

    const unjoined = new NextMeetingAction("uuid", service, { now, joinedKey: () => null });
    const k1 = fakeKey("k1");
    unjoined.onWillAppear(appearEv(k1, { feedId: "work", offset: 0 }));
    expect(lastImage(k1)).toContain("Free"); // dropped — never any red state
    unjoined.onWillDisappear(disappearEv(k1));

    const joined = new NextMeetingAction("uuid", service, {
      now,
      joinedKey: () => "gmeet:abc-def-ghi",
    });
    const k2 = fakeKey("k2");
    joined.onWillAppear(appearEv(k2, { feedId: "work", offset: 0 }));
    expect(lastImage(k2)).toContain("#0b2b30"); // held ⇒ calm teal in-call
    joined.onWillDisappear(disappearEv(k2));
  });
});
