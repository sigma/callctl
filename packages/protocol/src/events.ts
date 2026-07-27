/**
 * Event-name vocabulary shared by both ends of the websocket.
 *
 * Faithful port of `meetremote/internal/api` (api.go + google_hand.go). These
 * strings are the wire contract: the plugin sends Commands, the extension
 * pushes State events back. Changing a value here changes it for both ends at
 * once — that is the whole point of this package.
 */

/** Commands the plugin sends to the extension (extension registers handlers). */
export const Command = {
  LeaveCall: "leaveCall",
  MuteMic: "muteMic",
  UnmuteMic: "unmuteMic",
  ToggleMic: "toggleMic",
  GetMicState: "getMicState",
  DisableCamera: "disableCamera",
  EnableCamera: "enableCamera",
  ToggleCamera: "toggleCamera",
  GetCameraState: "getCameraState",
  ToggleParticipants: "toggleParticipants",
  ToggleChat: "toggleChat",
  // hand add-on (was gated behind `!public` in Go)
  RaiseHand: "raiseHand",
  LowerHand: "lowerHand",
  ToggleHand: "toggleHand",
  GetHandState: "getHandState",
  // react add-on (was gated behind `!public` in Go)
  React: "react",
  // captions add-on (label-keyed like hand; no `aria-pressed`)
  EnableCaptions: "enableCaptions",
  DisableCaptions: "disableCaptions",
  ToggleCaptions: "toggleCaptions",
  GetCaptionsState: "getCaptionsState",
  // config-over-the-wire selectors (see selectors.ts); currently driven by the
  // dev bridge — the @callctl/plugin Stream Deck side doesn't emit these yet
  SetSelectors: "setSelectors",
  GetSelectors: "getSelectors",
} as const;
export type Command = (typeof Command)[keyof typeof Command];

/** State events the extension pushes to the plugin. */
export const StateEvent = {
  CameraState: "cameraState",
  MicState: "micState",
  HandState: "handState",
  CaptionsState: "captionsState",
  /** Full {@link SelectorConfig} JSON, pushed after get/set-selectors. */
  Selectors: "selectors",
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
