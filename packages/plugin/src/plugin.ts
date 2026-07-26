import streamDeck from "@elgato/streamdeck";

import { MicToggle } from "./actions/mic-toggle.js";

streamDeck.actions.registerAction(new MicToggle());

streamDeck.connect();
