/**
 * The Meet DOM model: locates and reads Meet's control buttons purely by
 * `aria-label` / `data-is-muted`, and watches them for changes. Faithful port
 * of the legacy `model.ts`.
 *
 * NOTE: Meet's DOM (aria-labels, `data-is-muted`, the emoji `alt` text used by
 * the react plugin) changes over time. If commands stop clicking, verify these
 * selectors against live Meet first — that is the likeliest breakage, not the
 * transport.
 */

/** An `HTMLElement` with the ARIA reflection properties Meet sets. */
export interface AriaElement extends HTMLElement {
  ariaLabel: string | null;
  ariaSelected: string | null;
  ariaPressed: string | null;
}

/** Thin wrapper over a Meet control button exposing the bits we care about. */
export class UIElement {
  readonly #aria: AriaElement;

  constructor(e: AriaElement) {
    this.#aria = e;
  }

  selected(): boolean {
    return this.#aria.ariaSelected !== "true";
  }

  muted(): boolean {
    return this.#aria.dataset.isMuted === "true";
  }

  pressed(): boolean {
    return this.#aria.ariaPressed === "true";
  }

  click(): void {
    this.#aria?.click();
  }
}

export enum InputDevice {
  CAMERA = "camera",
  MIC = "microphone",
}

/** Thrown when a Meet control isn't in the DOM yet (expected at startup). */
export class ControlsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export interface Model {
  onMuteStateChange: (dev: InputDevice) => void;

  getMuteElement: (inputDevice: InputDevice) => UIElement | undefined;
  getElement: (label: string) => UIElement | undefined;
  getMuteState: (inputDevice: InputDevice) => boolean;
}

export class HTMLModel implements Model {
  /**
   * Reassigned by `CorePlugin.installHooks` after construction. The observer
   * below calls `this.onMuteStateChange` *dynamically* (not a value captured in
   * the constructor) so that reassignment actually takes effect — the legacy
   * code captured the empty default into a `const`, which silently dropped
   * every DOM-driven mute change and broke LED push-back.
   */
  onMuteStateChange: (dev: InputDevice) => void = () => {};
  readonly doc: Document;

  constructor(doc: Document = document) {
    this.doc = doc;

    const handleMuteStateChange = (mutationsList: MutationRecord[]): void => {
      for (const mutation of mutationsList) {
        if (mutation.type !== "attributes") {
          continue;
        }
        const target = mutation.target as AriaElement;
        const oldIsMuted = mutation.oldValue === "true";
        const newIsMuted = new UIElement(target).muted();

        if (mutation.oldValue === null || oldIsMuted !== newIsMuted) {
          const label = target.ariaLabel;
          for (const inputDevice of Object.values(InputDevice)) {
            if (label?.includes(inputDevice) ?? false) {
              this.onMuteStateChange(inputDevice);
            }
          }
        }
      }
    };

    this.#observeMuteStateChanges(handleMuteStateChange);
  }

  #observeMuteStateChanges(onChange: MutationCallback): void {
    const observer = new MutationObserver(onChange);
    observer.observe(this.doc.body, {
      childList: false,
      attributes: true,
      attributeFilter: ["data-is-muted"],
      attributeOldValue: true,
      subtree: true,
    });
  }

  getMuteElement(inputDevice: InputDevice): UIElement {
    const objs = [...this.doc.querySelectorAll<AriaElement>("[data-is-muted]")].filter((x) =>
      x.ariaLabel?.includes(inputDevice),
    );

    if (objs.length > 0) {
      return new UIElement(objs[0]);
    }
    throw new ControlsNotFoundError(`No mute/unmute button found for ${inputDevice}`);
  }

  getAriaElement(label: string): AriaElement {
    return [...this.doc.querySelectorAll<AriaElement>("[aria-label]")].filter((x) =>
      x.ariaLabel?.includes(label),
    )[0];
  }

  getElement(label: string): UIElement | undefined {
    const aria = this.getAriaElement(label);
    if (aria === undefined) {
      return undefined;
    }
    return new UIElement(aria);
  }

  getMuteState(inputDevice: InputDevice): boolean {
    return this.getMuteElement(inputDevice).muted();
  }
}
