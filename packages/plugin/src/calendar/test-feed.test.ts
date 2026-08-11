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

/** The same calendar with an owner address in `X-WR-CALNAME` (the §5.1 inference source). */
const CAL_NAMED = (calName: string, ...body: string[]) => CAL(`X-WR-CALNAME:${calName}`, ...body);

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
      identity: { source: "none", addresses: [] },
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
    expect(r).toEqual({
      ok: true,
      events: 0,
      joinable: 0,
      next: null,
      identity: { source: "none", addresses: [] },
    });
  });

  it("events present but none joinable → next is null", async () => {
    const impl = fakeFetch(new Response(CAL(...LINKLESS_EVENT), { status: 200 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toEqual({
      ok: true,
      events: 1,
      joinable: 0,
      next: null,
      identity: { source: "none", addresses: [] },
    });
  });
});

describe("testFeed — the identity in effect and where it came from (§5.1/§11)", () => {
  it("reports the configured identities, canonicalized as a poll would resolve them", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const r = await testFeed(SECRET, {
      fetchImpl: impl,
      now: NOW,
      identities: ["mailto:Me@Example.com", " alias@example.com "],
    });
    expect(r).toMatchObject({
      ok: true,
      identity: { source: "configured", addresses: ["alias@example.com", "me@example.com"] },
    });
  });

  it("configured wins outright — the feed's own X-WR-CALNAME never unions in", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW, identities: ["me@example.com"] });
    expect(JSON.stringify(r)).not.toContain("owner@example.com");
  });

  it("infers from an email-shaped X-WR-CALNAME and names the address", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toMatchObject({
      ok: true,
      identity: { source: "inferred", addresses: ["owner@example.com"] },
    });
  });

  it("a display-name X-WR-CALNAME is not an address → none", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("Arbora Team", ...MEET_EVENT)));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toMatchObject({ ok: true, identity: { source: "none", addresses: [] } });
  });

  it("an all-blank configured list falls through to inference", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW, identities: ["  ", ""] });
    expect(r).toMatchObject({ identity: { source: "inferred", addresses: ["owner@example.com"] } });
  });

  it("a 304 with no body reports unknown, not a none it never looked for", async () => {
    const impl = fakeFetch(new Response(null, { status: 304 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW });
    expect(r).toMatchObject({ ok: true, identity: { source: "unknown", addresses: [] } });
  });

  it("a 304 still reports a configured identity — it stands without a body", async () => {
    const impl = fakeFetch(new Response(null, { status: 304 }));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW, identities: ["me@example.com"] });
    expect(r).toMatchObject({
      ok: true,
      identity: { source: "configured", addresses: ["me@example.com"] },
    });
  });

  it("the counts stay identity-independent — §5.1 marks, it never drops", async () => {
    const declined = [
      "BEGIN:VEVENT",
      "UID:evt-3",
      "DTSTART:20990101T100000Z",
      "DTEND:20990101T110000Z",
      "SUMMARY:Standup",
      "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
      "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com",
      "END:VEVENT",
    ];
    const body = CAL(...declined);
    const mine = await testFeed(SECRET, {
      fetchImpl: fakeFetch(new Response(body)),
      now: NOW,
      identities: ["me@example.com"],
    });
    const theirs = await testFeed(SECRET, {
      fetchImpl: fakeFetch(new Response(body)),
      now: NOW,
      identities: ["someone-else@example.com"],
    });
    // §5.1 marks, it never drops: the instance is still joinable either way.
    expect(mine).toMatchObject({ ok: true, joinable: 1 });
    expect(theirs).toMatchObject({ ok: true, joinable: 1 });
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

  it("a success verdict carrying an identity still carries no URL", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const r = await testFeed(SECRET, { fetchImpl: impl, now: NOW, identities: ["me@example.com"] });
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
        identity: { source: "none", addresses: [] },
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

  it("forwards a well-formed identities list to the verdict", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const reply = await handlePiTestMessage(
      { command: "testFeed", requestId: "r-2", url: SECRET, identities: ["Me@example.com"] },
      { fetchImpl: impl, now: NOW },
    );
    expect(reply).toMatchObject({
      result: { identity: { source: "configured", addresses: ["me@example.com"] } },
    });
  });

  it("an absent identities field is fine — the feed still resolves by inference", async () => {
    const impl = fakeFetch(new Response(CAL_NAMED("owner@example.com", ...MEET_EVENT)));
    const reply = await handlePiTestMessage(
      { command: "testFeed", url: SECRET },
      { fetchImpl: impl, now: NOW },
    );
    expect(reply).toMatchObject({
      result: { identity: { source: "inferred", addresses: ["owner@example.com"] } },
    });
  });

  it("rejects a malformed identities field without touching the network", async () => {
    const impl = fakeFetch(new Response(CAL(...MEET_EVENT)));
    const opts = { fetchImpl: impl, now: NOW };
    const base = { command: "testFeed", requestId: "r-3", url: SECRET };
    expect(await handlePiTestMessage({ ...base, identities: "me@example.com" }, opts)).toBeNull();
    expect(await handlePiTestMessage({ ...base, identities: [42] }, opts)).toBeNull();
    expect(await handlePiTestMessage({ ...base, identities: [{}] }, opts)).toBeNull();
    expect(await handlePiTestMessage({ ...base, identities: null }, opts)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });
});
