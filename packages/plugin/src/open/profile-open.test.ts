import { describe, expect, it, vi } from "vitest";

import { buildOpenArgv, type OpenTarget, openWithProfile } from "./profile-open.js";

const MEET = "https://meet.google.com/abc-def-ghi";

describe("buildOpenArgv — per-OS launcher table (§7)", () => {
  it("wraps macOS in `open -n -a <AppName> --args …` with the URL last", () => {
    const argv = buildOpenArgv("darwin", { browser: "chrome", profile: "Profile 1" }, MEET);
    expect(argv).toEqual({
      file: "open",
      args: ["-n", "-a", "Google Chrome", "--args", "--profile-directory=Profile 1", MEET],
    });
  });

  it("execs the binary directly on Linux with the URL as its own argv element", () => {
    const argv = buildOpenArgv("linux", { browser: "brave", profile: "Default" }, MEET);
    expect(argv).toEqual({
      file: "brave-browser",
      args: ["--profile-directory=Default", MEET],
    });
  });

  it("execs the exe on Windows", () => {
    const argv = buildOpenArgv("win32", { browser: "edge", profile: "Default" }, MEET);
    expect(argv).toEqual({ file: "msedge", args: ["--profile-directory=Default", MEET] });
  });

  it("covers every browser in the enum for the current-family platforms", () => {
    const browsers: OpenTarget["browser"][] = ["chrome", "chromium", "edge", "brave"];
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const browser of browsers) {
        expect(buildOpenArgv(platform, { browser, profile: "Default" }, MEET)).toBeDefined();
      }
    }
  });

  it("returns undefined for an OS not in the table (→ caller degrades to tier 1)", () => {
    expect(buildOpenArgv("aix", { browser: "chrome", profile: "Default" }, MEET)).toBeUndefined();
  });

  it("keeps the URL a standalone element even when it looks like a flag or shell token", () => {
    const hostile = "https://meet.google.com/x; rm -rf ~ #--profile-directory=evil";
    const argv = buildOpenArgv("linux", { browser: "chrome", profile: "Default" }, hostile);
    // The whole hostile string is one argv element — never split, never a flag.
    expect(argv?.args.at(-1)).toBe(hostile);
    expect(argv?.args).toHaveLength(2);
  });
});

describe("openWithProfile — execFile side-effect (§7)", () => {
  const target: OpenTarget = { browser: "chrome", profile: "Profile 1" };

  it("resolves when the launcher exits cleanly, passing argv (no shell)", async () => {
    const exec = vi.fn((_file: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    await expect(
      openWithProfile(MEET, target, { platform: "linux", exec }),
    ).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith(
      "google-chrome",
      ["--profile-directory=Profile 1", MEET],
      expect.any(Function),
    );
  });

  it("rejects when the launcher errors (missing binary / non-zero exit) → tier-1 fallback", async () => {
    const exec = vi.fn((_f: string, _a: string[], cb: (e: Error | null) => void) =>
      cb(new Error("ENOENT")),
    );
    await expect(openWithProfile(MEET, target, { platform: "linux", exec })).rejects.toThrow(
      "ENOENT",
    );
  });

  it("rejects without spawning when the OS isn't in the table", async () => {
    const exec = vi.fn();
    await expect(openWithProfile(MEET, target, { platform: "aix", exec })).rejects.toThrow(
      /no launcher/,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
