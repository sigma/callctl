import { describe, expect, it, vi } from "vitest";
import { calendarFallbackUrl, fetchFeed, normalizeFeedUrl } from "./fetch.js";

const SECRET = "https://calendar.example.com/private-abcSECRETxyz/basic.ics";

/** A fake `fetch` that records the request and returns a canned `Response`. */
function fakeFetch(response: Response | (() => never)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (typeof response === "function") return response();
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("normalizeFeedUrl (§4 scheme rewrite)", () => {
  it("rewrites webcal:// → https://", () => {
    expect(normalizeFeedUrl("webcal://host/feed.ics")).toBe("https://host/feed.ics");
  });
  it("rewrites webcals:// → https://", () => {
    expect(normalizeFeedUrl("webcals://host/feed.ics")).toBe("https://host/feed.ics");
  });
  it("passes http(s) through", () => {
    expect(normalizeFeedUrl("https://host/feed.ics")).toBe("https://host/feed.ics");
    expect(normalizeFeedUrl("http://host/feed.ics")).toBe("http://host/feed.ics");
  });
  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeFeedUrl("mailto:a@b.com")).toThrow(TypeError);
    expect(() => normalizeFeedUrl("ftp://host/feed.ics")).toThrow(TypeError);
    expect(() => normalizeFeedUrl("file:///etc/passwd")).toThrow(TypeError);
  });
  it("rejects an unparseable URL", () => {
    expect(() => normalizeFeedUrl("not a url")).toThrow(TypeError);
  });
  it("never puts the URL in the thrown message (§12)", () => {
    try {
      normalizeFeedUrl("mailto:secret@example.com");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });
});

describe("calendarFallbackUrl (§6.4 tier-b feed-derived fallback)", () => {
  it("derives the feed's origin, dropping the secret path & query", () => {
    expect(
      calendarFallbackUrl("https://calendar.google.com/calendar/ical/SECRET123/basic.ics"),
    ).toBe("https://calendar.google.com");
  });
  it("rewrites webcal(s) before taking the origin", () => {
    expect(calendarFallbackUrl("webcal://p12.calendar.example/S3CR3T/feed.ics")).toBe(
      "https://p12.calendar.example",
    );
  });
  it("keeps a non-standard port in the origin", () => {
    expect(calendarFallbackUrl("https://host.example:8443/s/feed.ics")).toBe(
      "https://host.example:8443",
    );
  });
  it("never leaks the secret path into the derived URL", () => {
    const out = calendarFallbackUrl("https://cal.example/ical/SUPERSECRETTOKEN/basic.ics");
    expect(out).not.toContain("SUPERSECRETTOKEN");
  });
  it("returns undefined for an unparseable or non-http(s) feed URL", () => {
    expect(calendarFallbackUrl("not a url")).toBeUndefined();
    expect(calendarFallbackUrl("mailto:a@b.com")).toBeUndefined();
  });
});

describe("fetchFeed — conditional GET (§4)", () => {
  it("200 → modified with body and fresh validators (ETag preferred)", async () => {
    const { impl } = fakeFetch(
      new Response("ICSDATA", {
        status: 200,
        headers: { etag: '"v1"', "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    );
    const r = await fetchFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({
      kind: "modified",
      text: "ICSDATA",
      validators: { etag: '"v1"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
  });

  it("304 → not-modified (no body, reuse cache)", async () => {
    const { impl } = fakeFetch(new Response(null, { status: 304 }));
    const r = await fetchFeed(SECRET, {
      fetchImpl: impl,
      validators: { etag: '"v1"' },
    });
    expect(r).toEqual({ kind: "not-modified" });
  });

  it("sends If-None-Match / If-Modified-Since from stored validators", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 304 }));
    await fetchFeed(SECRET, {
      fetchImpl: impl,
      validators: { etag: '"v1"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"v1"');
    expect(headers["If-Modified-Since"]).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  it("sends no conditional headers and no Authorization on a cold poll", async () => {
    const { impl, calls } = fakeFetch(new Response("ICS", { status: 200 }));
    await fetchFeed(SECRET, { fetchImpl: impl });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(headers["If-Modified-Since"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("follows redirects", async () => {
    const { impl, calls } = fakeFetch(new Response("ICS", { status: 200 }));
    await fetchFeed(SECRET, { fetchImpl: impl });
    expect(calls[0].init.redirect).toBe("follow");
  });

  it("200 with no validators → modified with empty validators", async () => {
    const { impl } = fakeFetch(new Response("ICS", { status: 200 }));
    const r = await fetchFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({ kind: "modified", text: "ICS", validators: {} });
  });
});

describe("fetchFeed — failures are typed, never thrown, URL never leaked (§4/§9/§12)", () => {
  it("non-2xx/304 → error http with status", async () => {
    const { impl } = fakeFetch(new Response("nope", { status: 500 }));
    const r = await fetchFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({ kind: "error", reason: "http", status: 500 });
  });

  it("timeout (AbortSignal.timeout) → error timeout", async () => {
    const { impl } = fakeFetch(() => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const r = await fetchFeed(SECRET, { fetchImpl: impl, timeoutMs: 5 });
    expect(r).toEqual({ kind: "error", reason: "timeout" });
  });

  it("transport failure → error network", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const r = await fetchFeed(SECRET, { fetchImpl: impl });
    expect(r).toEqual({ kind: "error", reason: "network" });
  });

  it("bad scheme → error scheme (no network attempt)", async () => {
    const { impl, calls } = fakeFetch(new Response("x", { status: 200 }));
    const r = await fetchFeed("mailto:a@b.com", { fetchImpl: impl });
    expect(r).toEqual({ kind: "error", reason: "scheme" });
    expect(calls).toHaveLength(0);
  });

  it("no error result carries the feed URL (secret stays in-path)", async () => {
    const { impl } = fakeFetch(() => {
      // An error whose message embeds the secret URL, as undici's would.
      throw new TypeError(`request to ${SECRET} failed`);
    });
    const r = await fetchFeed(SECRET, { fetchImpl: impl });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(JSON.stringify(r)).not.toContain("calendar.example.com");
  });
});
