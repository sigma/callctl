import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarService } from "../calendar/service.js";
import type { FeedSnapshot, MeetingInstance } from "../calendar/types.js";
import { NextMeetingAction } from "./next-meeting-action.js";

/** A tier-(a) instance spanning `[startMs, endMs]` (absolute epoch ms). */
function instance(startMs: number, endMs: number, over: Partial<MeetingInstance> = {}): MeetingInstance {
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
}): CalendarService & { poll: ReturnType<typeof vi.fn> } {
  const svc = {
    pollIntervalMinutes: 15,
    snapshot: vi.fn((feedId: string) => (feedId === "work" ? opts.snapshot : undefined)),
    poll: vi.fn(async () => {}),
    pollAll: vi.fn(async () => {}),
    calendarFallback: vi.fn(() => opts.fallback),
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
      list: [instance(-60_000, 1_000, { title: "Running" }), instance(30_000, 60_000, { title: "Next" })],
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
      list: [instance(-60_000, 1_000, { title: "Running" }), instance(30_000, 60_000, { title: "Next" })],
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
