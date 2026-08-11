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
  const mock = () => (impl as unknown as { mock: { calls: unknown[][] } }).mock;
  return {
    impl,
    calls: () => mock().calls.length,
    /** Request headers the n-th call carried — `{}` when it sent none. */
    headers: (n: number) =>
      ((mock().calls[n]?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>,
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

  it("openConfig reflects a feed's tier-2 open target, reconciling on re-configure (§7)", () => {
    const svc = new CalendarService();
    const withOpen = parseGlobalSettings({
      feeds: [
        {
          id: "work",
          name: "Work",
          url: "https://host/secret.ics",
          open: { browser: "chrome", profile: "Work" },
        },
      ],
      pollIntervalMinutes: 15,
    });
    svc.configure(withOpen);
    expect(svc.openConfig("work")).toEqual({ browser: "chrome", profile: "Work" });
    // Unknown feed, and a feed reconfigured to drop `open`, both report undefined.
    expect(svc.openConfig("nope")).toBeUndefined();
    svc.configure(feeds());
    expect(svc.openConfig("work")).toBeUndefined();
  });
});

describe("CalendarService identity invalidation (§4, §5.1)", () => {
  // attendance.ics carries `X-WR-CALNAME:me@example.com` plus a mix of declined /
  // cancelled / accepted events on 2026-06-15.
  const ATTENDANCE = readFileSync(
    join(process.cwd(), "src/calendar/fixtures/attendance.ics"),
    "utf8",
  );
  const ATT_NOW = new Date("2026-06-15T14:00:00Z");
  const attOk200 = () => new Response(ATTENDANCE, { status: 200, headers: { etag: '"v1"' } });

  const withIdentities = (identities?: string[]) =>
    parseGlobalSettings({
      feeds: [{ id: "work", name: "Work", url: "https://host/secret.ics", identities }],
      pollIntervalMinutes: 15,
    });

  /** Titles of the instances the §5.1 verdict marked non-attending. */
  const declined = (svc: CalendarService) =>
    (svc.snapshot("work")?.list ?? []).filter((i) => !i.attending).map((i) => i.title);

  it("configured identities reach selectMeetings, beating the X-WR-CALNAME inference", async () => {
    const { impl } = fakeFetch([attOk200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities(["alias@example.com"]));
    await svc.poll("work", ATT_NOW);

    // Explicit wins outright: only the alias's decline counts, `me@example.com`'s
    // declines do not. Cancellation is ungated, so it still fires.
    expect(declined(svc).sort()).toEqual(["Alias declined", "Cancelled", "Cancelled lowercase"]);
  });

  it("with no configured identities the feed's X-WR-CALNAME is inferred", async () => {
    const { impl } = fakeFetch([attOk200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities());
    await svc.poll("work", ATT_NOW);

    expect(declined(svc)).toContain("Declined");
    expect(declined(svc)).not.toContain("Alias declined");
  });

  it("a changed identity list forces an unconditional re-fetch and re-select", async () => {
    const { impl, headers } = fakeFetch([attOk200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities(["alias@example.com"]));
    await svc.poll("work", ATT_NOW);
    expect(headers(0)["If-None-Match"]).toBeUndefined();

    svc.configure(withIdentities(["me@example.com"]));
    await svc.poll("work", ATT_NOW);

    // Validators dropped ⇒ no conditional headers ⇒ a real 200 the server cannot
    // answer with a 304 off our stale (post-selection) list.
    expect(headers(1)["If-None-Match"]).toBeUndefined();
    expect(headers(1)["If-Modified-Since"]).toBeUndefined();
    expect(declined(svc)).toContain("Declined");
    expect(declined(svc)).not.toContain("Alias declined");
  });

  it("keeps rendering the previous list while the re-fetch is in flight — no loading flash", async () => {
    const { impl } = fakeFetch([attOk200, netFail]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities(["alias@example.com"]));
    await svc.poll("work", ATT_NOW);
    const before = svc.snapshot("work");

    svc.configure(withIdentities(["me@example.com"]));

    const during = svc.snapshot("work");
    expect(during?.status).toBe("ok");
    expect(during?.list).toBe(before?.list);

    // `everLoaded` survived too: the forced re-fetch failing keeps the stale
    // cache rather than falling back to the cold-start error face (§9).
    await svc.poll("work", ATT_NOW);
    expect(svc.snapshot("work")?.status).toBe("ok");
  });

  it("an unchanged identity list is a no-op — validators survive", async () => {
    const { impl, headers } = fakeFetch([attOk200, notModified]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities(["me@example.com"]));
    await svc.poll("work", ATT_NOW);

    svc.configure(withIdentities(["me@example.com"]));
    await svc.poll("work", ATT_NOW);

    expect(headers(1)["If-None-Match"]).toBe('"v1"');
  });

  it("an edit that resolves to the same addresses is a no-op too (§5.1 normalization)", async () => {
    const { impl, headers } = fakeFetch([attOk200, notModified]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities(["me@example.com", "alias@example.com"]));
    await svc.poll("work", ATT_NOW);

    // Case, `mailto:`, ordering and a duplicate — all canonicalized away, so the
    // filter cannot have changed and there is nothing to re-select.
    svc.configure(withIdentities(["mailto:ALIAS@Example.com", "Me@example.com", "me@example.com"]));
    await svc.poll("work", ATT_NOW);

    expect(headers(1)["If-None-Match"]).toBe('"v1"');
  });

  it("setUrl still returns the feed to cold-start — the contrast (§4)", async () => {
    const { impl } = fakeFetch([attOk200]);
    const svc = new CalendarService({ fetchImpl: impl });
    svc.configure(withIdentities(["me@example.com"]));
    await svc.poll("work", ATT_NOW);
    expect(svc.snapshot("work")?.list.length ?? 0).toBeGreaterThan(0);

    svc.configure(
      parseGlobalSettings({
        feeds: [{ id: "work", name: "Work", url: "https://host/rotated.ics" }],
        pollIntervalMinutes: 15,
      }),
    );
    const snap = svc.snapshot("work");
    expect(snap?.status).toBe("loading");
    expect(snap?.list).toEqual([]);
  });
});
