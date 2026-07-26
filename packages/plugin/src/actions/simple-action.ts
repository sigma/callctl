import { SingletonAction } from "@elgato/streamdeck";

/**
 * A stateless "button" action: pressing it fires a single command at the
 * remote. Mirrors the Go `simpleTrigger` (leave-call, mic-on/off,
 * camera-on/off, chat, participants, hand-on/off, and every reaction).
 *
 * The SDK binds one class to one manifest UUID via the `@action` decorator, but
 * we need many actions backed by the same behaviour, so we set `manifestId`
 * per-instance in the constructor (exactly what the decorator does under the
 * hood) and register one instance per UUID.
 */
export class SimpleAction extends SingletonAction {
  readonly #press: () => void;

  constructor(uuid: string, press: () => void) {
    super();
    // `manifestId` is typed readonly (set by the decorator); we set it here
    // instead so a single class can serve many UUIDs.
    (this as { manifestId: string }).manifestId = uuid;
    this.#press = press;
  }

  override onKeyDown(): void {
    this.#press();
  }
}
