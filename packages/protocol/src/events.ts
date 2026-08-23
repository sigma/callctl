/**
 * Event-name vocabulary shared by both ends of the websocket.
 *
 * Faithful port of `meetremote/internal/api` (api.go + google_hand.go). These
 * strings are the wire contract: the plugin sends Commands, the extension
 * pushes State events back. Changing a value here changes it for both ends at
 * once — that is the whole point of this package.
 *
 * **Every operation below is namespaced `meet.*`.** Operation names are the
 * bridge's routing keys — a client's capability set is literally the set of ops
 * its plugins registered (ADR 0001) — so they have to be unique across surfaces,
 * not just within one. `toggleMic` is unique today only because Chat has no mic;
 * a second meeting platform collides with it immediately, and by then renaming
 * is a wire break against a shipped surface instead of a mechanical edit.
 *
 * The namespace is per *surface*, not per package: `chat.*` ops live in
 * `chat.ts`. Genuinely surface-neutral channels stay unprefixed — the debug
 * channel (`debug.ts`) introspects whichever DOM is on the other end.
 */

/** Commands the plugin sends to the extension (extension registers handlers). */
export const Command = {
  LeaveCall: "meet.leaveCall",
  MuteMic: "meet.muteMic",
  UnmuteMic: "meet.unmuteMic",
  ToggleMic: "meet.toggleMic",
  GetMicState: "meet.getMicState",
  DisableCamera: "meet.disableCamera",
  EnableCamera: "meet.enableCamera",
  ToggleCamera: "meet.toggleCamera",
  GetCameraState: "meet.getCameraState",
  ToggleParticipants: "meet.toggleParticipants",
  ToggleChat: "meet.toggleChat",
  // hand add-on (was gated behind `!public` in Go)
  RaiseHand: "meet.raiseHand",
  LowerHand: "meet.lowerHand",
  ToggleHand: "meet.toggleHand",
  GetHandState: "meet.getHandState",
  // react add-on (was gated behind `!public` in Go)
  React: "meet.react",
  // captions add-on (label-keyed like hand; no `aria-pressed`)
  EnableCaptions: "meet.enableCaptions",
  DisableCaptions: "meet.disableCaptions",
  ToggleCaptions: "meet.toggleCaptions",
  GetCaptionsState: "meet.getCaptionsState",
  // config-over-the-wire selectors (see selectors.ts); currently driven by the
  // dev bridge — the @callctl/plugin Stream Deck side doesn't emit these yet
  SetSelectors: "meet.setSelectors",
  GetSelectors: "meet.getSelectors",
} as const;
export type Command = (typeof Command)[keyof typeof Command];

/** State events the extension pushes to the plugin. */
export const StateEvent = {
  CameraState: "meet.cameraState",
  MicState: "meet.micState",
  HandState: "meet.handState",
  CaptionsState: "meet.captionsState",
  /**
   * Optional read-only join-detection signal (§10). `data` is the
   * provider-namespaced canonical join code of the call you are *in* (e.g.
   * `gmeet:abc-def-ghi`); the event with **no `data`** means "not in a call".
   * The extension pushes it on transition (Leave-call button appears/disappears
   * or the code changes) and on connect. Consumed by `NextMeetingAction` to
   * dismiss the late state the instant you actually join — never drives Meet.
   */
  CallState: "meet.callState",
  /** Full {@link MeetSelectorConfig} JSON, pushed after get/set-selectors. */
  Selectors: "meet.selectors",
} as const;
export type StateEvent = (typeof StateEvent)[keyof typeof StateEvent];

/** `data` values carried by the state events above. */
export const StateValue = {
  Muted: "muted",
  Unmuted: "unmuted",
  Lowered: "lowered",
  Raised: "raised",
  CaptionsOn: "captionsOn",
  CaptionsOff: "captionsOff",
} as const;
export type StateValue = (typeof StateValue)[keyof typeof StateValue];

/** Default local websocket port shared by plugin (listen) and extension (dial). */
export const DEFAULT_PORT = 2395;
