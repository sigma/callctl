/**
 * Tier-2 press-to-open (§7): open a join URL in a **specific browser profile**
 * instead of the default browser. Reached only when the surfaced event's feed
 * carries an `open: { browser, profile }` (§3); absent that, the action uses
 * tier 1 (`streamDeck.system.openUrl`).
 *
 * The security posture (§12) is structural: we exec with
 * `child_process.execFile` and an **argv array** — never a shell string — and
 * the URL is its **own argv element**. Shell injection is impossible by
 * construction; the only user-supplied inputs are the `browser` enum (a closed
 * set) and the `profile` folder name (a single, un-split argv element).
 *
 * {@link buildOpenArgv} is a pure per-OS argv table (unit-tested with no spawn);
 * {@link openWithProfile} is the thin `execFile` side-effect the plugin injects
 * into the action, mirroring how tier 1's `openUrl` is injected.
 */

import { execFile } from "node:child_process";

import type { BrowserId } from "../settings.js";

/**
 * A per-feed profile-open target (§3): which browser, which profile folder.
 * Structurally the `open` shape on {@link import("../settings.js").NamedFeed}.
 */
export interface OpenTarget {
  browser: BrowserId;
  /** Literal `--profile-directory` folder name (`Default`, `Profile 1`, …). */
  profile: string;
}

/** A resolved launch: the executable and its argv (the URL is always its own element). */
export interface OpenArgv {
  file: string;
  args: string[];
}

/**
 * The per-OS launcher table (§7). macOS shells out to `open -na "<AppName>"`;
 * Linux/Windows exec the browser binary/exe directly. All Chromium-family
 * browsers accept `--profile-directory`, so only the app/binary/exe name varies.
 */
const APP_TABLE: Record<NodeJS.Platform, Record<BrowserId, string> | undefined> = {
  // macOS: `open -na "<AppName>"` → argv table maps to the .app display name.
  darwin: {
    chrome: "Google Chrome",
    chromium: "Chromium",
    edge: "Microsoft Edge",
    brave: "Brave Browser",
  },
  // Linux: exec the binary on PATH directly.
  linux: {
    chrome: "google-chrome",
    chromium: "chromium",
    edge: "microsoft-edge",
    brave: "brave-browser",
  },
  // Windows: exec the .exe (on PATH, else spawn fails → the action degrades to tier 1).
  win32: {
    chrome: "chrome",
    chromium: "chromium",
    edge: "msedge",
    brave: "brave",
  },
} as Record<NodeJS.Platform, Record<BrowserId, string> | undefined>;

/**
 * Build the `execFile` argv for opening `url` in `target`'s browser profile on
 * `platform`, or `undefined` when the OS or browser isn't in the table (→ the
 * caller degrades to tier 1). The URL is always the **last, standalone** argv
 * element, so no calendar-controlled string can ever be interpreted as a flag or
 * a shell token (§12).
 */
export function buildOpenArgv(
  platform: NodeJS.Platform,
  target: OpenTarget,
  url: string,
): OpenArgv | undefined {
  const app = APP_TABLE[platform]?.[target.browser];
  if (app === undefined) return undefined;
  const profileFlag = `--profile-directory=${target.profile}`;
  if (platform === "darwin") {
    // `open -n -a "<AppName>" --args --profile-directory=<profile> <url>`:
    // `-n` opens a new instance, `--args` forwards the rest to the app.
    return { file: "open", args: ["-n", "-a", app, "--args", profileFlag, url] };
  }
  // Linux & Windows: `<binary|exe> --profile-directory=<profile> <url>`.
  return { file: app, args: [profileFlag, url] };
}

/** Injectable spawn seam so {@link openWithProfile} is unit-testable without a real browser. */
export interface OpenWithProfileDeps {
  platform?: NodeJS.Platform;
  /** Defaults to `node:child_process.execFile`; a stub captures argv in tests. */
  exec?: (file: string, args: string[], cb: (err: Error | null) => void) => void;
}

/**
 * Open `url` in `target`'s browser profile via `execFile` (§7 tier 2).
 * Fire-and-forget like tier 1: the returned Promise settles on the **launch**,
 * not on the browser actually rendering — only spawn-level failure is
 * detectable. Rejects when the OS/browser isn't in the table, the binary is
 * missing, or the launcher exits non-zero; the action turns any rejection into
 * the tier-1 fallback + `showAlert` + log (§7 degradation).
 */
export function openWithProfile(
  url: string,
  target: OpenTarget,
  deps: OpenWithProfileDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const argv = buildOpenArgv(platform, target, url);
  if (argv === undefined) {
    return Promise.reject(
      new Error(`no launcher for browser "${target.browser}" on platform "${platform}"`),
    );
  }
  const exec = deps.exec ?? execFile;
  return new Promise<void>((resolve, reject) => {
    exec(argv.file, argv.args, (err) => (err ? reject(err) : resolve()));
  });
}
