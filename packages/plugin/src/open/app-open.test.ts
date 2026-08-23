import { describe, expect, it, vi } from "vitest";

import { buildChatLaunchArgv, CHAT_URL, openChatApp } from "./app-open.js";
import { buildOpenArgv } from "./profile-open.js";

/**
 * The tier-2 Chat launch. Pure argv assertions, no spawn — which is the point:
 * every claim here is about the *switches*, and the switches are where this
 * differs from the next-meeting key's open in ways that matter.
 */

const target = { profile: "Profile 1", appId: "mdpkiolbdkhdjpekfbkbmhigcaggjagi" };

describe("buildChatLaunchArgv", () => {
  it("targets the installed app by id, in the configured profile", () => {
    // `--app-id` is what produces a genuine focus of the existing window:
    // Chat's manifest asks for `focus-existing`, and the browser honours it on
    // this path. `--app=<url>` would open a new window every time.
    expect(buildChatLaunchArgv("darwin", target)).toEqual({
      file: "open",
      args: [
        "-a",
        "Google Chrome",
        "--args",
        "--profile-directory=Profile 1",
        `--app-id=${target.appId}`,
      ],
    });
  });

  it("🔴 never passes -n", () => {
    // `open(1)` documents `-n` as forcing a NEW instance, which is the opposite
    // of a raise-the-window press. The next-meeting key's helper does pass it —
    // that is a separate Meet-side question, and the contrast is the reason
    // these are two builders rather than one with a flag.
    const chat = buildChatLaunchArgv("darwin", target);
    expect(chat?.args).not.toContain("-n");
    expect(
      buildOpenArgv("darwin", { browser: "chrome", profile: "Profile 1" }, "x")?.args,
    ).toContain("-n");
  });

  it("execs the binary directly on Linux and Windows", () => {
    expect(buildChatLaunchArgv("linux", target)).toEqual({
      file: "google-chrome",
      args: ["--profile-directory=Profile 1", `--app-id=${target.appId}`],
    });
    expect(buildChatLaunchArgv("win32", target)?.file).toBe("chrome");
  });

  it("falls back to a URL when Chat is not installed as an app", () => {
    // No app id ⇒ nothing to target ⇒ a command-line URL, which navigates as
    // AUTO_TOPLEVEL and so opens a tab rather than the app window. Documented
    // degradation: the window is raised in spirit, if not as an app window.
    const argv = buildChatLaunchArgv("darwin", { profile: "Default", appId: "" });
    expect(argv?.args).toEqual([
      "-a",
      "Google Chrome",
      "--args",
      "--profile-directory=Default",
      CHAT_URL,
    ]);
  });

  it("gives up when there is no profile to launch into", () => {
    expect(buildChatLaunchArgv("darwin", { profile: "", appId: target.appId })).toBeUndefined();
  });

  it("gives up on an OS with no launcher", () => {
    expect(buildChatLaunchArgv("aix", target)).toBeUndefined();
  });
});

describe("openChatApp", () => {
  it("execs the built argv, never a shell string", async () => {
    const exec = vi.fn((_file: string, _args: string[], cb: (err: Error | null) => void) =>
      cb(null),
    );
    await openChatApp(target, { platform: "linux", exec });

    expect(exec).toHaveBeenCalledWith("google-chrome", expect.any(Array), expect.any(Function));
  });

  it("rejects when there is nothing to target, so the caller can degrade", async () => {
    await expect(openChatApp({ profile: "", appId: "" }, { platform: "linux" })).rejects.toThrow(
      /no Chat launcher/,
    );
  });

  it("rejects when the launcher fails", async () => {
    const exec = vi.fn((_f: string, _a: string[], cb: (err: Error | null) => void) =>
      cb(new Error("ENOENT")),
    );
    await expect(openChatApp(target, { platform: "linux", exec })).rejects.toThrow("ENOENT");
  });
});
