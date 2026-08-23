import { ChatCommand, ChatEvent, type ChatRoster, message } from "@callctl/protocol";
import type { Disposer } from "../core/disposer.js";
import type { SurfacePlugin } from "../core/plugin.js";
import type { Transport } from "../core/transport/transport.js";
import { domVisibleText, readRoster, sameRoster, type VisibleText } from "./roster.js";
import { type ChatSelectorRegistry, chatSelectors } from "./selectors.js";

/**
 * How long to let a mutation storm settle before re-scanning. Chat re-renders
 * the roster in bursts, and a scan per mutation would be dozens of full
 * `querySelectorAll` sweeps for one state change.
 */
const RESCAN_DEBOUNCE_MS = 100;

/**
 * The live unread roster: scan on demand, and re-scan whenever the DOM moves.
 *
 * Observes broadly from `document.documentElement` rather than from the roster
 * list, and re-queries the rows on every scan rather than holding node
 * references. Meet re-renders its controls and can swap `<body>` outright;
 * nothing suggests Chat is better behaved, and a narrow observer that silently
 * detaches is indistinguishable from "nothing is unread".
 *
 * No polling: the deck key must decrement the moment a conversation is read.
 */
export class RosterModel {
  readonly #doc: Document;
  readonly #registry: ChatSelectorRegistry;
  readonly #visibleText: VisibleText;
  readonly #listeners = new Set<(roster: ChatRoster) => void>();

  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #last: ChatRoster = { conversations: [] };

  constructor(
    doc: Document = document,
    registry: ChatSelectorRegistry = chatSelectors,
    visibleText: VisibleText = domVisibleText,
  ) {
    this.#doc = doc;
    this.#registry = registry;
    this.#visibleText = visibleText;
  }

  /**
   * Scan now. Reads the selector config fresh, so an override applies here.
   *
   * The result becomes the baseline the change detector compares against — an
   * explicit resync or an on-connect push is a scan like any other, and leaving
   * the baseline stale would make the very next observation report a change
   * that had already been sent.
   */
  read(): ChatRoster {
    this.#last = readRoster(this.#doc, this.#registry.all(), this.#visibleText);
    return this.#last;
  }

  /**
   * Subscribe to roster changes. **Additive** — a `Set` of listeners, never a
   * single settable field: a second subscriber must not be able to clobber the
   * first, which is exactly how Meet's LEDs once went stale.
   */
  onChange(listener: (roster: ChatRoster) => void): Disposer {
    this.#listeners.add(listener);
    this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop();
      }
    };
  }

  #start(): void {
    if (this.#observer !== null) {
      return;
    }
    this.#observer = new MutationObserver(() => this.#schedule());
    this.#observer.observe(this.#doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  #stop(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #schedule(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  #rescan(): void {
    const previous = this.#last;
    const roster = this.read(); // …which advances the baseline
    // Chat re-renders constantly; only a genuine change is worth a wire frame.
    if (sameRoster(roster, previous)) {
      return;
    }
    for (const listener of this.#listeners) {
      listener(roster);
    }
  }
}

/**
 * Pushes the unread roster over the bridge.
 *
 * **The client pushes on connect** rather than waiting to be asked —
 * deliberately unlike Meet, which asks on connect because its state lives in a
 * DOM it must query each time. This client is already observing its roster
 * continuously, so ask-then-answer would add a round trip and a window in which
 * the key shows stale-or-nothing. `chat.getRoster` exists for explicit resync.
 *
 * No MIDI capability: MIDI is Meet-only (ADR 0002), and inventing a CC number
 * here would give MIDI something to route to by accident.
 */
class RosterPlugin implements SurfacePlugin {
  readonly #model: RosterModel;

  constructor(model: RosterModel) {
    this.#model = model;
  }

  ID(): string {
    return "roster";
  }

  installHooks(t: Transport): void {
    const push = (roster: ChatRoster) => t.send(message(ChatEvent.Roster, JSON.stringify(roster)));

    t.onDetach(this.#model.onChange(push));

    // A reconnect means the far end knows nothing, so push unconditionally —
    // the snapshot is idempotent, which is exactly why it is a snapshot.
    t.onConnect = () => push(this.#model.read());
  }

  installHandlers(t: Transport): void {
    t.handle(ChatCommand.GetRoster, () =>
      t.send(message(ChatEvent.Roster, JSON.stringify(this.#model.read()))),
    );
  }
}

export function newRosterPlugin(model: RosterModel = new RosterModel()): SurfacePlugin {
  console.log("loading chat roster plugin");
  return new RosterPlugin(model);
}
