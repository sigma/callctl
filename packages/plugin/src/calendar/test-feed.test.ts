import { describe, expect, it, vi } from "vitest";
import { handlePiTestMessage, testFeed } from "./test-feed.js";

const SECRET = "https://calendar.example.com/private-abcSECRETxyz/basic.ics";

/** A fake `fetch` returning a canned `Response` (or throwing, for transport failures). */
function fakeFetch(response: Response | (() => never)) {
  return vi.fn(async () => {
    if (typeof response === "function") return response();
    return response;
  }) as unknown as typeof fetch;
}

const CAL = (...body: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//EN", ...body, "END:VCALENDAR"].join(
    "\r\n",
  );

// A fixed reference instant; the events sit just after it and well within the
// engine's ~400-day expansion horizon, so selection keeps them deterministically.
const NOW = new Date(Date.UTC(2099, 0, 1, 9, 0, 0));
const MEET_START_MS = Date.UTC(2099, 0, 1, 10, 0, 0);

/** A Google Meet event one hour after NOW — selection always keeps it (end > now). */
const MEET_EVENT = [
  "BEGIN:VEVENT",
  "UID:evt-1",
  "DTSTART:20990101T100000Z",
  "DTEND:20990101T110000Z",
  "SUMMARY:Standup",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "END:VEVENT",
];

/** An event with no join link — parsed, but dropped from the joinable list (tier c). */
const LINKLESS_EVENT = [
  "BEGIN:VEVENT",
  "UID:evt-2",
  "DTSTART:20990102T100000Z",
  "DTEND:20990102T110000Z",
  "SUMMARY:No link here",
  "END:VEVENT",
];

describe("testFeed — success (§11)", () => {
  it("reports reachable, parsed-N, and the next joinable event", async () => {
    const impl = fakeFetch(new Response(CAL(...MEET_EVENT), { status: 200 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toEqual({
      ok: true,
      events: 1,
      joinable: 1,
      next: { title: "Standup", startMs: MEET_START_MS },
    });
  });

  it("counts all VEVENTs but only link-bearing ones as joinable", async () => {
    const impl = fakeFetch(new Response(CAL(...MEET_EVENT, ...LINKLESS_EVENT), { status: 200 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toMatchObject({ ok: true, events: 2, joinable: 1 });
    expect(r).toHaveProperty("next.title", "Standup");
  });

  it("a valid but empty calendar is reachable with no events", async () => {
    const impl = fakeFetch(new Response(CAL(), { status: 200 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toEqual({ ok: true, events: 0, joinable: 0, next: null });
  });

  it("events present but none joinable → next is null", async () => {
    const impl = fakeFetch(new Response(CAL(...LINKLESS_EVENT), { status: 200 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toEqual({ ok: true, events: 1, joinable: 0, next: null });
  });
});

describe("testFeed — failures are typed and specific (§11)", () => {
  it("HTTP error surfaces the status (e.g. 401)", async () => {
    const impl = fakeFetch(new Response("nope", { status: 401 }));
    const r = await testFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({ ok: false, error: "http", status: 401 });
  });

  it("a non-iCal 200 body → not-a-calendar", async () => {
    const impl = fakeFetch(new Response("<html>login page</html>", { status: 200 }));
    const r = await testFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({ ok: false, error: "not-a-calendar" });
  });

  it("timeout → timeout", async () => {
    const impl = fakeFetch(() => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const r = await testFeed(SECRET, { fetchImpl: impl, timeoutMs: 5 });
    expect(r).toEqual({ ok: false, error: "timeout" });
  });

  it("transport failure → network", async () => {
    const impl = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const r = await testFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({ ok: false, error: "network" });
  });

  it("bad scheme → scheme", async () => {
    const impl = fakeFetch(new Response("x", { status: 200 }));
    const r = await testFeed("mailto:a@b.com", { fetchImpl: impl });
    expect(r).toEqual({ ok: false, error: "scheme" });
  });
});

describe("testFeed — the feed URL (secret) never leaks into the verdict (§12)", () => {
  it("no result carries the URL, even on a URL-echoing transport error", async () => {
    const impl = fakeFetch(() => {
      throw new TypeError(`request to ${SECRET} failed`);
    });
    const r = await testFeed(SECRET, { fetchImpl: impl });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(JSON.stringify(r)).not.toContain("calendar.example.com");
  });
});

describe("handlePiTestMessage — PI [Test] round-trip envelope (§11)", () => {
  it("wraps a testFeed verdict in a testResult reply, echoing requestId", async () => {
    const impl = fakeFetch(new Response(CAL(...MEET_EVENT), { status: 200 }));
    const reply = await handlePiTestMessage(
      { command: "testFeed", requestId: "r-1", url: SECRET },
      { fetchImpl: impl, now: NOW },
    );
    expect(reply).toEqual({
      command: "testResult",
      requestId: "r-1",
      result: {
        ok: true,
        events: 1,
        joinable: 1,
        next: { title: "Standup", startMs: MEET_START_MS },
      },
    });
  });

  it("defaults a missing requestId to an empty string", async () => {
    const impl = fakeFetch(new Response(CAL(), { status: 200 }));
    const reply = await handlePiTestMessage(
      { command: "testFeed", url: SECRET },
      { fetchImpl: impl, now: NOW },
    );
    expect(reply).toMatchObject({ command: "testResult", requestId: "" });
  });

  it("ignores non-testFeed messages and malformed payloads (returns null)", async () => {
    const impl = fakeFetch(new Response(CAL(), { status: 200 }));
    const opts = { fetchImpl: impl };
    expect(await handlePiTestMessage({ command: "somethingElse" }, opts)).toBeNull();
    expect(await handlePiTestMessage({ command: "testFeed" }, opts)).toBeNull(); // no url
    expect(await handlePiTestMessage({ command: "testFeed", url: 42 }, opts)).toBeNull();
    expect(await handlePiTestMessage(null, opts)).toBeNull();
    expect(await handlePiTestMessage("nope", opts)).toBeNull();
  });
});
