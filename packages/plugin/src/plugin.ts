import streamDeck from "@elgato/streamdeck";

import { buildActions } from "./actions/index.js";
import { CalendarService } from "./calendar/service.js";
import { handlePiTestMessage } from "./calendar/test-feed.js";
import { MeetRemote } from "./remote/meet-remote.js";
import { parseGlobalSettings } from "./settings.js";

// The plugin hosts the local websocket server; the Chrome extension dials in.
const remote = new MeetRemote({ log: (m) => streamDeck.logger.info(m) });

// The Next-Meeting feed engine (§9): one shared cache registry across every key.
const calendar = new CalendarService();

// Press-to-open (§7 tier 1): the host performs the OS-level open into the
// default browser; the plugin only forwards the URL and logs failures.
const nextMeetingDeps = {
  openUrl: (url: string) => streamDeck.system.openUrl(url),
  log: (message: string) => streamDeck.logger.info(message),
};

for (const action of buildActions(remote, calendar, nextMeetingDeps)) {
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

remote.start().catch((err) => {
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
