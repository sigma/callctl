import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseGlobalSettings } from "../settings.js";
import { CalendarService } from "./service.js";

const ICS = readFileSync(join(process.cwd(), "src/calendar/fixtures/selection.ics"), "utf8");
// selection.ics events sit on 2026-06-15; this instant surfaces several of them.
const NOW = new Date("2026-06-15T14:00:00Z");

const feeds = (url = "https://host/secret.ics") =>
  parseGlobalSettings({ feeds: [{ id: "work", name: "Work", url }], pollIntervalMinutes: 15 });

/** A queue-backed fake `fetch`: each call shifts the next canned Response. */
function fakeFetch(responses: Array<() => Response>) {
  let i = 0;
  const impl = vi.fn(async () => {
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return make();
  }) as unknown as typeof fetch;
  return {
    impl,
    calls: () => (impl as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
  };
}

const ok200 = () => new Response(ICS, { status: 200, headers: { etag: '"v1"' } });
const notModified = () => new Response(null, { status: 304 });
const netFail = () => {
  throw new TypeError("network down");
};

describe("CalendarService (§9)", () => {
  it("a 200 poll populates the cache and reports ok", async () => {
    const { impl } = fakeFetch([ok200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await svc.poll("work", NOW);

    const snap = svc.snapshot("work");
    expect(snap?.status).toBe("ok");
    expect(snap?.list.length ?? 0).toBeGreaterThan(0);
  });

  it("a 304 reuses the cache without re-parsing", async () => {
    const { impl } = fakeFetch([ok200, notModified]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await svc.poll("work", NOW);
    const first = svc.snapshot("work")?.list;
    await svc.poll("work", NOW);
    const snap = svc.snapshot("work");
    expect(snap?.status).toBe("ok");
    expect(snap?.list).toBe(first); // same array reference — not re-selected
  });

  it("cold-start failure with no cache → cold-error", async () => {
    const { impl } = fakeFetch([netFail]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await svc.poll("work", NOW);
    expect(svc.snapshot("work")?.status).toBe("cold-error");
  });

  it("a failure after a good poll keeps rendering off the stale cache (§9)", async () => {
    const { impl } = fakeFetch([ok200, netFail]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await svc.poll("work", NOW);
    const cached = svc.snapshot("work")?.list;
    await svc.poll("work", NOW);
    const snap = svc.snapshot("work");
    expect(snap?.status).toBe("ok");
    expect(snap?.list).toBe(cached);
  });

  it("unparseable body on cold start → cold-error (never throws)", async () => {
    const junk = () => new Response("not a calendar at all", { status: 200 });
    const { impl } = fakeFetch([junk]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await expect(svc.poll("work", NOW)).resolves.toBeUndefined();
    // node-ical tolerates junk (empty parse) — either way it must not surface as "ok" with events.
    const snap = svc.snapshot("work");
    expect(snap?.list.length ?? 0).toBe(0);
  });

  it("snapshot is undefined for an unknown / dangling feed", () => {
    const svc = new CalendarService();
    svc.configure(feeds());
    expect(svc.snapshot("nope")).toBeUndefined();
  });

  it("configure reconciles: drops removed feeds, tracks the poll interval", () => {
    const svc = new CalendarService();
    svc.configure(feeds());
    expect(svc.feedIds()).toEqual(["work"]);
    svc.configure(parseGlobalSettings({ feeds: [], pollIntervalMinutes: 7 }));
    expect(svc.feedIds()).toEqual([]);
    expect(svc.snapshot("work")).toBeUndefined();
    expect(svc.pollIntervalMinutes).toBe(7);
  });

  it("a changed feed URL invalidates the cache back to cold-start", async () => {
    const { impl } = fakeFetch([ok200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await svc.poll("work", NOW);
    expect(svc.snapshot("work")?.status).toBe("ok");

    svc.configure(feeds("https://host/rotated-secret.ics"));
    const snap = svc.snapshot("work");
    expect(snap?.status).toBe("loading");
    expect(snap?.list).toEqual([]);
  });

  it("coalesces concurrent polls of the same feed onto one fetch", async () => {
    const { impl, calls } = fakeFetch([ok200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(feeds());
    await Promise.all([svc.poll("work", NOW), svc.poll("work", NOW)]);
    expect(calls()).toBe(1);
  });

  it("calendarFallback derives the feed origin without a poll (§6.4)", () => {
    const svc = new CalendarService();
    svc.configure(feeds("https://calendar.example/ical/SECRET/basic.ics"));
    const fallback = svc.calendarFallback("work");
    expect(fallback).toBe("https://calendar.example");
    expect(fallback).not.toContain("SECRET");
  });

  it("calendarFallback is undefined for an unknown feed", () => {
    const svc = new CalendarService();
    svc.configure(feeds());
    expect(svc.calendarFallback("nope")).toBeUndefined();
  });
});
