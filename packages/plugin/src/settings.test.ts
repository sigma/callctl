import { describe, expect, it } from "vitest";

import {
  DEFAULT_HORIZON_MINUTES,
  DEFAULT_OFFSET,
  DEFAULT_POLL_INTERVAL_MINUTES,
  parseGlobalSettings,
  parseKeySettings,
  resolveFeed,
} from "./settings.js";

describe("parseGlobalSettings (§3)", () => {
  it("defaults an empty/garbage object to no feeds + default poll interval", () => {
    for (const raw of [undefined, null, 42, {}, { feeds: "nope" }]) {
      expect(parseGlobalSettings(raw)).toEqual({
        feeds: [],
        pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
      });
    }
  });

  it("keeps well-formed feeds and reads the poll interval", () => {
    const g = parseGlobalSettings({
      feeds: [{ id: "work", name: "Work", url: "https://host/secret.ics" }],
      pollIntervalMinutes: 5,
    });
    expect(g.pollIntervalMinutes).toBe(5);
    expect(g.feeds).toEqual([{ id: "work", name: "Work", url: "https://host/secret.ics" }]);
  });

  it("drops feeds missing an id or url (unreferenceable / unfetchable)", () => {
    const g = parseGlobalSettings({
      feeds: [
        { name: "no id", url: "https://host/a.ics" },
        { id: "no-url", name: "no url" },
        { id: "ok", name: "Ok", url: "https://host/b.ics" },
      ],
    });
    expect(g.feeds.map((f) => f.id)).toEqual(["ok"]);
  });

  it("falls back to the default interval for a non-positive value", () => {
    expect(parseGlobalSettings({ pollIntervalMinutes: 0 }).pollIntervalMinutes).toBe(
      DEFAULT_POLL_INTERVAL_MINUTES,
    );
    expect(parseGlobalSettings({ pollIntervalMinutes: -3 }).pollIntervalMinutes).toBe(
      DEFAULT_POLL_INTERVAL_MINUTES,
    );
  });

  it("keeps a valid per-feed open target and drops a malformed one", () => {
    const g = parseGlobalSettings({
      feeds: [
        {
          id: "a",
          name: "A",
          url: "https://h/a.ics",
          open: { browser: "chrome", profile: "Profile 1" },
        },
        {
          id: "b",
          name: "B",
          url: "https://h/b.ics",
          open: { browser: "netscape", profile: "x" },
        },
        { id: "c", name: "C", url: "https://h/c.ics", open: { browser: "edge", profile: "" } },
      ],
    });
    expect(g.feeds[0].open).toEqual({ browser: "chrome", profile: "Profile 1" });
    expect(g.feeds[1].open).toBeUndefined();
    expect(g.feeds[2].open).toBeUndefined();
  });

  it("keeps a known border-color token and drops absent/empty/unknown/raw-hex (#78)", () => {
    const g = parseGlobalSettings({
      feeds: [
        { id: "a", name: "A", url: "https://h/a.ics", color: "teal" },
        { id: "b", name: "B", url: "https://h/b.ics", color: "puce" },
        { id: "c", name: "C", url: "https://h/c.ics", color: "#ff5c8a" },
        { id: "d", name: "D", url: "https://h/d.ics", color: "" },
        { id: "e", name: "E", url: "https://h/e.ics" },
      ],
    });
    expect(g.feeds[0].color).toBe("teal");
    expect(g.feeds[1].color).toBeUndefined();
    expect(g.feeds[2].color).toBeUndefined();
    expect(g.feeds[3].color).toBeUndefined();
    expect(g.feeds[4].color).toBeUndefined();
  });

  it("keeps trimmed non-empty identities and omits the field otherwise (§3, §5.1)", () => {
    const g = parseGlobalSettings({
      feeds: [
        { id: "a", name: "A", url: "https://h/a.ics", identities: ["  me@example.com ", "x@y.co"] },
        { id: "b", name: "B", url: "https://h/b.ics" },
        { id: "c", name: "C", url: "https://h/c.ics", identities: [] },
        { id: "d", name: "D", url: "https://h/d.ics", identities: "me@example.com" },
        { id: "e", name: "E", url: "https://h/e.ics", identities: ["", "   "] },
        {
          id: "f",
          name: "F",
          url: "https://h/f.ics",
          identities: [42, null, "me@example.com", {}],
        },
      ],
    });
    expect(g.feeds[0].identities).toEqual(["me@example.com", "x@y.co"]);
    // Absent, empty, non-array, all-blank: no field at all — an empty list would
    // only be a second way to say "unset" (§5.1 falls through to inference).
    expect(g.feeds[1].identities).toBeUndefined();
    expect(g.feeds[2].identities).toBeUndefined();
    expect(g.feeds[3].identities).toBeUndefined();
    expect(g.feeds[4].identities).toBeUndefined();
    // Mixed junk: the string survivors are kept, the rest dropped.
    expect(g.feeds[5].identities).toEqual(["me@example.com"]);
  });
});

describe("parseKeySettings (§3)", () => {
  it("defaults a fresh key to unconfigured", () => {
    expect(parseKeySettings({})).toEqual({
      feedId: "",
      offset: DEFAULT_OFFSET,
      horizonMinutes: DEFAULT_HORIZON_MINUTES,
    });
  });

  it("reads values and truncates a fractional offset", () => {
    expect(parseKeySettings({ feedId: "work", offset: 2.9, horizonMinutes: 120 })).toEqual({
      feedId: "work",
      offset: 2,
      horizonMinutes: 120,
    });
  });

  it("clamps a negative offset back to the default", () => {
    const s = parseKeySettings({ feedId: "w", offset: -1 });
    expect(s.offset).toBe(DEFAULT_OFFSET);
  });

  it("ignores a stale graceMinutes blob from an older Property Inspector", () => {
    // The setting was retired; any leftover value in the store is simply dropped.
    expect(parseKeySettings({ feedId: "w", graceMinutes: 42 })).not.toHaveProperty("graceMinutes");
  });

  it("falls back to the default horizon for a non-positive or missing value", () => {
    expect(parseKeySettings({}).horizonMinutes).toBe(DEFAULT_HORIZON_MINUTES);
    expect(parseKeySettings({ horizonMinutes: 0 }).horizonMinutes).toBe(DEFAULT_HORIZON_MINUTES);
    expect(parseKeySettings({ horizonMinutes: -30 }).horizonMinutes).toBe(DEFAULT_HORIZON_MINUTES);
  });
});

describe("resolveFeed (§3)", () => {
  const g = parseGlobalSettings({
    feeds: [{ id: "work", name: "Work", url: "https://host/w.ics" }],
  });
  it("finds a feed by id", () => {
    expect(resolveFeed(g, "work")?.name).toBe("Work");
  });
  it("returns undefined for an empty or dangling feedId", () => {
    expect(resolveFeed(g, "")).toBeUndefined();
    expect(resolveFeed(g, "deleted")).toBeUndefined();
  });
});
