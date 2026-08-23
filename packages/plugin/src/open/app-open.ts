/**
 * Launching an **installed Chrome app** in a specific profile — the Chat key's
 * tier-2 press, reached when no client is attached.
 *
 * A sibling of `profile-open.ts` rather than a flag on it, for one load-bearing
 * reason: 🔴 **`openWithProfile` passes `-n`**, which `open(1)` documents as
 * forcing a *new instance*. That is exactly wrong for a raise-the-window press,
 * whose whole purpose is to reach the window that already exists. (Whether `-n`
 * is also wrong for the next-meeting key's tier-2 open is a separate Meet-side
 * question, deliberately out of scope, so that helper stays untouched.)
 *
 * Same security posture as its sibling and for the same reasons: `execFile` with
 * an **argv array**, never a shell string, so no user-supplied value can be
 * interpreted as a shell token.
 */

import { execFile } from "node:child_process";

import type { BrowserId } from "../settings.js";
import type { OpenArgv, OpenWithProfileDeps } from "./profile-open.js";

/** Where Chat lives when it is not installed as an app. */
export const CHAT_URL = "https://chat.google.com";

/** A tier-2 Chat launch: which profile, and which installed app (if any). */
export interface AppTarget {
  /** Chromium-family browser. Chat is a Chrome app, so this defaults to Chrome. */
  browser?: BrowserId;
  /** Literal `--profile-directory` folder name, so the right account opens. */
  profile: string;
  /**
   * The installed app's id.
   *
   * **Configuration, not computed.** The documented a–p SHA-256 derivation over
   * Chat's served manifest id yields a *different* value from the installed
   * app's actual id; read it from the app's own metadata (`CrAppModeShortcutID`
   * in the macOS shim's `Info.plist`) or from `chrome://web-app-internals`.
   *
   * Empty means Chat is not installed as an app — see {@link buildChatLaunchArgv}.
   */
  appId: string;
}

const APP_TABLE: Record<NodeJS.Platform, Record<BrowserId, string> | undefined> = {
  darwin: {
    chrome: "Google Chrome",
    chromium: "Chromium",
    edge: "Microsoft Edge",
    brave: "Brave Browser",
  },
  linux: {
    chrome: "google-chrome",
    chromium: "chromium",
    edge: "microsoft-edge",
    brave: "brave-browser",
  },
  win32: {
    chrome: "chrome",
    chromium: "chromium",
    edge: "msedge",
    brave: "brave",
  },
} as Record<NodeJS.Platform, Record<BrowserId, string> | undefined>;

/**
 * Build the `execFile` argv for a tier-2 Chat launch, or `undefined` when there
 * is nothing to target (no profile configured, or an OS/browser not in the
 * table) — the caller then degrades to a host-delegated URL open.
 *
 * With an `appId`, the launch targets **the installed app by id**. That is what
 * produces a genuine focus rather than a second window: Chat's own manifest
 * ships `"launch_handler": {"client_mode": "focus-existing"}`, which the browser
 * honours on this path. `--app-id` is a shipping cross-platform switch and the
 * one Chrome writes into its own generated shortcuts; `--app=<url>` is the wrong
 * switch — new window every time, no installed-app lookup.
 *
 * Without one, the URL goes on the command line instead, which opens a **tab**:
 * command-line URLs navigate as `PAGE_TRANSITION_AUTO_TOPLEVEL`, which is
 * excluded from web-app navigation capturing. That is the documented
 * degradation, not an oversight — the window is raised in spirit, if not as an
 * app window.
 *
 * 🔴 Note the absence of `-n` on the macOS branch. See the module comment.
 */
export function buildChatLaunchArgv(
  platform: NodeJS.Platform,
  target: AppTarget,
): OpenArgv | undefined {
  const app = APP_TABLE[platform]?.[target.browser ?? "chrome"];
  if (app === undefined || target.profile === "") {
    return undefined;
  }
  // Composing `--profile-directory` with `--app-id` is why this beats the macOS
  // shim route (`open -b com.google.Chrome.app.<id>`), which is viable but
  // carries no profile selector.
  const flags = [`--profile-directory=${target.profile}`];
  flags.push(target.appId !== "" ? `--app-id=${target.appId}` : CHAT_URL);

  if (platform === "darwin") {
    // `open -a "<AppName>" --args …` — **no `-n`**: forcing a new instance is
    // the opposite of what a raise-the-window press means.
    return { file: "open", args: ["-a", app, "--args", ...flags] };
  }
  return { file: app, args: flags };
}

/**
 * Launch Chat for `target` via `execFile`. Fire-and-forget: the promise settles
 * on the **launch**, not on the window appearing — only spawn-level failure is
 * detectable. Rejects when there is nothing to target or the launcher fails, and
 * the caller degrades to a host-delegated URL open.
 */
export function openChatApp(target: AppTarget, deps: OpenWithProfileDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const argv = buildChatLaunchArgv(platform, target);
  if (argv === undefined) {
    return Promise.reject(
      new Error(`no Chat launcher for profile "${target.profile}" on platform "${platform}"`),
    );
  }
  const exec = deps.exec ?? execFile;
  return new Promise<void>((resolve, reject) => {
    exec(argv.file, argv.args, (err) => (err ? reject(err) : resolve()));
  });
}
