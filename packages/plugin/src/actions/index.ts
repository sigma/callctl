import { REACTION_SLUGS } from "@callctl/protocol";
import type { SingletonAction } from "@elgato/streamdeck";

import type { MeetRemote } from "../remote/meet-remote.js";
import { SimpleAction } from "./simple-action.js";
import { ToggleAction } from "./toggle-action.js";

/** Plugin action namespace; every action UUID is `${NAMESPACE}.<key>`. */
export const NAMESPACE = "dev.yrh.callctl";

const uuid = (key: string) => `${NAMESPACE}.${key}`;
/** Flat image path for a staged icon basename (see imgs/actions/). */
const img = (basename: string) => `imgs/actions/${basename}`;

/**
 * Build every plugin action, wired to the shared remote. This is the single
 * source of truth for the action set — the faithful port of the Go
 * `DefaultTriggers` / `DefaultStateHandlers` maps (plus hand + reactions).
 * The hand-written manifest must list a matching `Actions[]` entry per UUID.
 */
export function buildActions(remote: MeetRemote): SingletonAction[] {
  const actions: SingletonAction[] = [];

  // Stateless "buttons": pressing fires one command. The staged image basename
  // is the key with dashes turned to underscores (leave-call → leave_call).
  const simple: Array<[key: string, press: () => void]> = [
    ["leave-call", () => remote.leave()],
    ["mic-off", () => remote.muteMic()],
    ["mic-on", () => remote.unmuteMic()],
    ["camera-off", () => remote.disableCamera()],
    ["camera-on", () => remote.enableCamera()],
    ["toggle-chat", () => remote.toggleChat()],
    ["toggle-participants", () => remote.toggleParticipants()],
    // Note the Go naming quirk: "hand-off" raises, "hand-on" lowers.
    ["hand-off", () => remote.raiseHand()],
    ["hand-on", () => remote.lowerHand()],
  ];
  for (const [key, press] of simple) {
    actions.push(new SimpleAction(uuid(key), press));
  }

  // One reaction button per slug (react-wave, react-yes, …).
  for (const slug of REACTION_SLUGS) {
    actions.push(new SimpleAction(uuid(`react-${slug}`), () => remote.react(slug)));
  }

  // Three-visual toggles (connected-on / connected-off / disconnected).
  actions.push(
    new ToggleAction(
      {
        uuid: uuid("mic-toggle"),
        toggle: () => remote.toggleMic(),
        ask: () => remote.askMicState(),
        led: () => remote.micState(),
        disconnectedImage: img("mic_disconnected"),
      },
      remote,
    ),
    new ToggleAction(
      {
        uuid: uuid("camera-toggle"),
        toggle: () => remote.toggleCamera(),
        ask: () => remote.askCameraState(),
        led: () => remote.cameraState(),
        disconnectedImage: img("camera_disconnected"),
      },
      remote,
    ),
    new ToggleAction(
      {
        uuid: uuid("hand-toggle"),
        toggle: () => remote.toggleHand(),
        ask: () => remote.askHandState(),
        led: () => remote.handState(),
        disconnectedImage: img("hand_disconnected"),
      },
      remote,
    ),
  );

  return actions;
}
