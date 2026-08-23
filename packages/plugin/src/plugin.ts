import { Bridge } from "@callctl/bridge";
import { DEFAULT_PORT } from "@callctl/protocol";
import streamDeck from "@elgato/streamdeck";

import { buildActions } from "./actions/index.js";
import { CalendarService } from "./calendar/service.js";
import { handlePiTestMessage } from "./calendar/test-feed.js";
import { openWithProfile } from "./open/profile-open.js";
import { ChatRemote } from "./remote/chat-remote.js";
import { MeetRemote } from "./remote/meet-remote.js";
import { type BrowserId, parseGlobalSettings } from "./settings.js";

// The plugin hosts the local websocket server; the Chrome extension's content
// scripts dial in as clients. **One bridge, many clients** — a Meet tab and a
// Chat window coexist rather than evicting each other (ADR 0001), so each
// surface's remote is a consumer of the same server rather than a server of
// its own.
const log = (m: string) => streamDeck.logger.info(m);
const bridge = new Bridge({ port: DEFAULT_PORT, log });
const remote = new MeetRemote({ bridge, log });
const chat = new ChatRemote({ bridge, log });

// The Next-Meeting feed engine (§9): one shared cache registry across every key.
const calendar = new CalendarService();

// Press-to-open (§7): tier 1 delegates to the host (default browser); tier 2
// execs into a feed's configured browser profile (`execFile`, no shell) and
// degrades back to tier 1 on any launch failure. The plugin only forwards the
// URL/target and logs failures.
const nextMeetingDeps = {
  openUrl: (url: string) => streamDeck.system.openUrl(url),
  openWith: (url: string, target: { browser: BrowserId; profile: string }) =>
    openWithProfile(url, target),
  log: (message: string) => streamDeck.logger.info(message),
};

for (const action of buildActions(remote, calendar, nextMeetingDeps, chat)) {
  streamDeck.actions.registerAction(action);
}

// Keep the calendar service configured from global settings (§3), which the
// Property Inspector (§11, #60) writes. On every change, reconcile and force an
// immediate poll so the keys reflect the new config without waiting for the next
// cadence (§9).
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  calendar.configure(parseGlobalSettings(ev.settings));
  void calendar.pollAll(new Date());
});

// The Property Inspector's [Test] button (§11): a one-shot fetch+parse of a
// candidate feed URL, routed through the pure handler so the wire round-trip is
// the only SDK-coupled part. Non-testFeed messages yield null and are ignored.
streamDeck.ui.onSendToPlugin(async (ev) => {
  const reply = await handlePiTestMessage(ev.payload);
  if (reply === null) return;
  // The reply is plain JSON; cast through `unknown` to the SDK's payload type
  // without importing its bundled JsonValue (not re-exported from the entry).
  await streamDeck.ui.sendToPropertyInspector(
    reply as unknown as Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0],
  );
});

streamDeck.connect();

bridge.start().catch((err: Error) => {
  streamDeck.logger.error(`failed to start remote server: ${err.message}`);
});

// Pull the initial global settings once connected (this also primes the caches).
streamDeck.settings
  .getGlobalSettings()
  .then((g) => {
    calendar.configure(parseGlobalSettings(g));
    return calendar.pollAll(new Date());
  })
  .catch((err) => streamDeck.logger.error(`failed to load global settings: ${err.message}`));
