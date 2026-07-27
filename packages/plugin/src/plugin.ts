import streamDeck from "@elgato/streamdeck";

import { buildActions } from "./actions/index.js";
import { CalendarService } from "./calendar/service.js";
import { MeetRemote } from "./remote/meet-remote.js";
import { parseGlobalSettings } from "./settings.js";

// The plugin hosts the local websocket server; the Chrome extension dials in.
const remote = new MeetRemote({ log: (m) => streamDeck.logger.info(m) });

// The Next-Meeting feed engine (§9): one shared cache registry across every key.
const calendar = new CalendarService();

for (const action of buildActions(remote, calendar)) {
  streamDeck.actions.registerAction(action);
}

// Keep the calendar service configured from global settings (§3). For v1 the
// feed list is seeded manually as JSON global settings; the Property Inspector
// arrives in #60. On every change, reconcile and force an immediate poll so the
// keys reflect the new config without waiting for the next cadence (§9).
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  calendar.configure(parseGlobalSettings(ev.settings));
  void calendar.pollAll(new Date());
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
