import streamDeck from "@elgato/streamdeck";

import { buildActions } from "./actions/index.js";
import { MeetRemote } from "./remote/meet-remote.js";

// The plugin hosts the local websocket server; the Chrome extension dials in.
const remote = new MeetRemote({ log: (m) => streamDeck.logger.info(m) });

for (const action of buildActions(remote)) {
  streamDeck.actions.registerAction(action);
}

streamDeck.connect();
remote.start().catch((err) => {
  streamDeck.logger.error(`failed to start remote server: ${err.message}`);
});
