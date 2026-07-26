import {
  action,
  SingletonAction,
  type KeyDownEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

/**
 * Phase-1 placeholder: a self-contained mic toggle that just flips its own
 * button state and logs. No websocket yet — its only job is to prove the
 * edit → rebuild → `streamdeck restart` dev loop works end to end.
 *
 * Phase 2 replaces the body with real MeetRemote websocket calls.
 */
@action({ UUID: "dev.yrh.meetdeck.mic-toggle" })
export class MicToggle extends SingletonAction {
  private muted = false;

  /**
   * A reload restarts the process, so `muted` resets. Stream Deck persists the
   * key's visual state across the restart, so resync from it on (re)appear.
   * (In phase 2 the source of truth becomes Meet, not this local flag.)
   */
  override onWillAppear(ev: WillAppearEvent): void {
    this.muted = ev.payload.state === 1;
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    this.muted = !this.muted;
    streamDeck.logger.info(
      `mic-toggle toggled → ${this.muted ? "muted" : "unmuted"}`,
    );
    await ev.action.setState(this.muted ? 1 : 0);
  }
}
