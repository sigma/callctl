import { action, SingletonAction, type KeyDownEvent } from "@elgato/streamdeck";
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

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    this.muted = !this.muted;
    streamDeck.logger.info(`mic-toggle pressed → ${this.muted ? "muted" : "unmuted"}`);
    await ev.action.setState(this.muted ? 1 : 0);
  }
}
