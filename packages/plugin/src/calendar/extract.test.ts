import { describe, expect, it } from "vitest";

import { extractJoinCandidate, firstUrlIn, isJoinUrl } from "./extract.js";
import type { ParsedEvent } from "./types.js";

/** A parsed VEVENT with only the given fields set (mirrors node-ical's shape). */
const ev = (fields: ParsedEvent): ParsedEvent => fields;

describe("isJoinUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(isJoinUrl("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(isJoinUrl("http://example.com/x")).toBe(true);
  });

  it("rejects non-http schemes and non-URLs", () => {
    expect(isJoinUrl("mailto:alice@example.com")).toBe(false);
    expect(isJoinUrl("tel:+15551234567")).toBe(false);
    expect(isJoinUrl("123 Main St, Springfield")).toBe(false);
    expect(isJoinUrl("")).toBe(false);
  });
});

describe("firstUrlIn", () => {
  it("returns undefined when there is no URL", () => {
    expect(firstUrlIn("Bring your laptop. Room 4B.")).toBeUndefined();
  });

  it("prefers a known conferencing host over an earlier arbitrary link", () => {
    const body =
      "Agenda: https://docs.example.com/agenda\nJoin: https://meet.google.com/abc-defg-hij";
    expect(firstUrlIn(body)).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("falls back to the first URL when no known host is present", () => {
    expect(firstUrlIn("see https://foo.example.com/a then https://bar.example.com/b")).toBe(
      "https://foo.example.com/a",
    );
  });

  it("strips trailing punctuation that abuts a URL in prose", () => {
    expect(firstUrlIn("Join at https://meet.google.com/abc-defg-hij.")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });
});

describe("extraction precedence (§6.1)", () => {
  it("rung 1 — X-GOOGLE-CONFERENCE (de-prefixed) wins over everything", () => {
    const result = extractJoinCandidate(
      ev({
        "GOOGLE-CONFERENCE": "https://meet.google.com/abc-defg-hij",
        location: "https://us02web.zoom.us/j/1234567890",
        description: "https://zoom.us/j/9876543210",
      }),
    );
    expect(result).toEqual({
      tier: "a",
      provider: "gmeet",
      code: "gmeet:abc-defg-hij",
      joinUrl: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("rung 2 — LOCATION only when the whole value is a URL", () => {
    const asUrl = extractJoinCandidate(ev({ location: "https://us02web.zoom.us/j/1234567890" }));
    expect(asUrl).toMatchObject({ tier: "a", provider: "zoom" });

    // A location that merely embeds a URL does NOT match rung 2.
    const embedded = extractJoinCandidate(
      ev({ location: "Zoom: https://us02web.zoom.us/j/1234567890 (ID 123 456 7890)" }),
    );
    expect(embedded).toBeNull();
  });

  it("rung 3 — DESCRIPTION body embedded URL", () => {
    const result = extractJoinCandidate(
      ev({ description: "Weekly sync.\nJoin: https://meet.google.com/abc-defg-hij\nThanks" }),
    );
    expect(result).toMatchObject({ tier: "a", provider: "gmeet" });
  });

  it("rung 3b — X-ALT-DESC as a { params, val } (FMTTYPE) property", () => {
    const result = extractJoinCandidate(
      ev({
        "ALT-DESC": {
          params: { FMTTYPE: "text/html" },
          val: '<a href="x">Join</a> https://meet.google.com/abc-defg-hij',
        },
      }),
    );
    expect(result).toMatchObject({ tier: "a", provider: "gmeet" });
  });

  it("rung 4 — URL property as the last resort", () => {
    const result = extractJoinCandidate(ev({ url: "https://us02web.zoom.us/j/1234567890" }));
    expect(result).toMatchObject({ tier: "a", provider: "zoom", code: "zoom:1234567890" });
  });

  it("later rungs are only consulted when earlier ones yield nothing", () => {
    // GOOGLE-CONFERENCE present but not a URL → fall through to LOCATION.
    const result = extractJoinCandidate(
      ev({ "GOOGLE-CONFERENCE": "not a url", location: "https://us02web.zoom.us/j/1234567890" }),
    );
    expect(result).toMatchObject({ tier: "a", provider: "zoom" });
  });
});

describe("Google Meet canonicalization (§6.2)", () => {
  it("reconstructs and discards query + fragment", () => {
    const result = extractJoinCandidate(
      ev({ "GOOGLE-CONFERENCE": "https://meet.google.com/abc-defg-hij?authuser=0#foo" }),
    );
    expect(result).toEqual({
      tier: "a",
      provider: "gmeet",
      code: "gmeet:abc-defg-hij",
      joinUrl: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("forces https even if the extracted value was http", () => {
    const result = extractJoinCandidate(
      ev({ "GOOGLE-CONFERENCE": "http://meet.google.com/abc-defg-hij" }),
    );
    expect(result).toMatchObject({ joinUrl: "https://meet.google.com/abc-defg-hij" });
  });

  it("demotes a malformed Meet code to tier (b), never errors", () => {
    expect(
      extractJoinCandidate(ev({ "GOOGLE-CONFERENCE": "https://meet.google.com/xxx" })),
    ).toEqual({ tier: "b" });
    expect(
      extractJoinCandidate(ev({ "GOOGLE-CONFERENCE": "https://meet.google.com/lookup/whatever" })),
    ).toEqual({ tier: "b" });
  });
});

describe("Zoom canonicalization (§6.2)", () => {
  it("pins host, reconstructs /j/<id>, preserves a valid pwd, discards other params", () => {
    const result = extractJoinCandidate(
      ev({ location: "https://us02web.zoom.us/j/1234567890?pwd=aB.9-_x&uname=mallory" }),
    );
    expect(result).toEqual({
      tier: "a",
      provider: "zoom",
      code: "zoom:1234567890",
      joinUrl: "https://us02web.zoom.us/j/1234567890?pwd=aB.9-_x",
    });
  });

  it("discards an invalid pwd but still reconstructs", () => {
    const result = extractJoinCandidate(
      ev({ location: "https://zoom.us/j/1234567890?pwd=bad pwd!" }),
    );
    expect(result).toEqual({
      tier: "a",
      provider: "zoom",
      code: "zoom:1234567890",
      joinUrl: "https://zoom.us/j/1234567890",
    });
  });

  it("demotes a look-alike host (not *.zoom.us) to tier (b)", () => {
    expect(
      extractJoinCandidate(ev({ location: "https://zoom.us.evil.example/j/1234567890" })),
    ).toEqual({ tier: "b" });
  });

  it("demotes a zoom host without a valid /j/<id> to tier (b)", () => {
    expect(extractJoinCandidate(ev({ location: "https://zoom.us/my/personal-room" }))).toEqual({
      tier: "b",
    });
    expect(extractJoinCandidate(ev({ location: "https://zoom.us/j/123" }))).toEqual({ tier: "b" });
  });
});

describe("Microsoft Teams canonicalization (§6.2)", () => {
  it("passes an allowlisted meetup-join URL through untouched", () => {
    const url =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc?context=%7b%22Tid%22%3a%22x%22%7d";
    const result = extractJoinCandidate(ev({ location: url }));
    expect(result).toEqual({ tier: "a", provider: "teams", joinUrl: url });
    expect((result as { code?: string }).code).toBeUndefined();
  });

  it("demotes a Teams host with a non-meetup path to tier (b)", () => {
    expect(
      extractJoinCandidate(ev({ location: "https://teams.microsoft.com/l/channel/19%3aabc" })),
    ).toEqual({ tier: "b" });
  });

  it("demotes teams.live.com (recognized as a candidate, not canonicalizable) to tier (b)", () => {
    expect(
      extractJoinCandidate(ev({ location: "https://teams.live.com/meet/9999999999" })),
    ).toEqual({ tier: "b" });
  });
});

describe("tiers (§6.3)", () => {
  it("unknown provider with a real link → tier (b)", () => {
    expect(extractJoinCandidate(ev({ location: "https://example.webex.com/meet/room" }))).toEqual({
      tier: "b",
    });
  });

  it("non-meeting event (no candidate) → null (tier c)", () => {
    expect(
      extractJoinCandidate(ev({ location: "Room 4B", description: "Bring your laptop." })),
    ).toBeNull();
    expect(extractJoinCandidate(ev({}))).toBeNull();
  });

  it("non-http candidate is not treated as a link → null", () => {
    expect(extractJoinCandidate(ev({ location: "mailto:team@example.com" }))).toBeNull();
  });
});
