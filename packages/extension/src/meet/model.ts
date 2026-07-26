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
  /**
   * Subscribe to mute-state transitions. This is an *additive* subscription, not
   * a single settable callback: the plugin's `installHooks` is invoked once per
   * transport (WS + MIDI) by `MultiProtocol`, and each needs to push
   * independently. A single overwritable field let the last (MIDI, whose `send`
   * is a no-op) clobber the websocket's push, so state changes never reached the
   * plugin — the toggle LEDs went stale.
   */
  onMuteStateChange: (listener: (dev: InputDevice) => void) => void;

  getMuteElement: (inputDevice: InputDevice) => UIElement | undefined;
  getElement: (label: string) => UIElement | undefined;
  getMuteState: (inputDevice: InputDevice) => boolean;
}

export class HTMLModel implements Model {
  readonly doc: Document;

  /** Mute-change subscribers (see {@link Model.onMuteStateChange}). */
  readonly #muteListeners = new Set<(dev: InputDevice) => void>();
  /** Last mute state we observed per device, to detect genuine transitions. */
  readonly #lastMuted = new Map<InputDevice, boolean>();
  #rescanQueued = false;

  onMuteStateChange(listener: (dev: InputDevice) => void): void {
    this.#muteListeners.add(listener);
  }

  constructor(doc: Document = document) {
    this.doc = doc;

    // Meet no longer reliably mutates `data-is-muted` in place when the mute
    // state changes — it re-renders the control as a fresh node. An
    // attribute-only observer therefore never fires, so state changes made by
    // anything other than the toggle itself (a mic-off button, or Meet's own
    // UI) were silently dropped and the toggle LEDs went stale. Instead we
    // watch broadly (childList + attribute) and re-derive the mute state on
    // each batch, pushing only real transitions. The re-scan is coalesced to
    // one cheap pass per microtask so Meet's constant DOM churn stays cheap.
    // Observe from documentElement, not body: Meet (a SPA) can swap out the
    // body/container after our content script attaches, which would leave an
    // observer bound to `body` watching a detached, stale subtree — so it never
    // fired. `documentElement` (<html>) is never replaced.
    const observer = new MutationObserver(() => this.#scheduleRescan());
    observer.observe(this.doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-is-muted"],
    });
  }

  #scheduleRescan(): void {
    if (this.#rescanQueued) {
      return;
    }
    this.#rescanQueued = true;
    queueMicrotask(() => {
      this.#rescanQueued = false;
      this.#rescanMuteState();
    });
  }

  #rescanMuteState(): void {
    for (const dev of Object.values(InputDevice)) {
      let muted: boolean;
      try {
        muted = this.getMuteState(dev);
      } catch {
        continue; // control not in the DOM right now
      }
      if (this.#lastMuted.get(dev) !== muted) {
        this.#lastMuted.set(dev, muted);
        for (const listener of this.#muteListeners) {
          listener(dev);
        }
      }
    }
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

  /**
   * The element's accessible name: its `aria-label`, or — when absent — the
   * text of the element(s) its `aria-labelledby` points at. Meet increasingly
   * labels controls via `aria-labelledby` (e.g. the participants button, whose
   * name "People" lives in a referenced span), so matching on `aria-label`
   * alone silently misses them.
   */
  #accessibleName(el: Element): string | null {
    const label = el.getAttribute("aria-label");
    if (label !== null) {
      return label;
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby !== null) {
      const name = labelledby
        .split(/\s+/)
        .map((id) => this.doc.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (name !== "") {
        return name;
      }
    }
    return null;
  }

  getAriaElement(label: string): AriaElement {
    return [...this.doc.querySelectorAll<AriaElement>("[aria-label], [aria-labelledby]")].filter(
      (x) => this.#accessibleName(x)?.includes(label),
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
