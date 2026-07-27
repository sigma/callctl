import { describe, expect, test } from "vitest";
import { isMeetingUrl } from "./location.js";

describe("isMeetingUrl", () => {
  test("a meeting-code room is a meeting", () => {
    expect(isMeetingUrl("https://meet.google.com/xqy-ebgf-wsx")).toBe(true);
  });

  test("query and hash are ignored", () => {
    expect(isMeetingUrl("https://meet.google.com/xqy-ebgf-wsx?authuser=1")).toBe(true);
    expect(isMeetingUrl("https://meet.google.com/xqy-ebgf-wsx#pin")).toBe(true);
  });

  test("landing, home and lookup pages are not meetings", () => {
    expect(isMeetingUrl("https://meet.google.com/landing")).toBe(false);
    expect(isMeetingUrl("https://meet.google.com/")).toBe(false);
    expect(isMeetingUrl("https://meet.google.com/new")).toBe(false);
    expect(isMeetingUrl("https://meet.google.com/lookup/abcdefg")).toBe(false);
  });

  test("a code with the wrong shape is not a meeting", () => {
    expect(isMeetingUrl("https://meet.google.com/xqy-ebgf")).toBe(false); // too few groups
    expect(isMeetingUrl("https://meet.google.com/XQY-EBGF-WSX")).toBe(false); // uppercase
    expect(isMeetingUrl("https://meet.google.com/xqy-ebgf-wsx/extra")).toBe(false); // trailing seg
  });

  test("other hosts and junk are not meetings", () => {
    expect(isMeetingUrl("https://evil.example.com/xqy-ebgf-wsx")).toBe(false);
    expect(isMeetingUrl("not a url")).toBe(false);
  });
});
