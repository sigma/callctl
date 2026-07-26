# Prototype — in-Meet transport widget shell

Answers wayfinder ticket **#4 — Widget UI shell: placement, form, survival in Meet DOM**
(child of Map #1, *In-Meet transport control widget*).

Run: `open packages/extension/prototypes/widget-shell/index.html` — switch variants with
the bottom bar, `←`/`→`, or `?variant=A|B|C`. Throwaway; delete once the answer lands.

## The three questions

### 1. Placement + 2. Form — **prototyped** (this is the design decision)

Three structurally-different takes, over a faux-Meet backdrop for density:

- **A — Floating card, bottom-right.** Compact draggable card above Meet's control bar.
  Four groups stacked vertically; MIDI checklist inline. Fully self-owned DOM → lowest
  survival risk. Own footprint, doesn't pretend to be native.
- **B — Native bar button + popover.** One extra circular button injected *inline* with
  Meet's own mic/camera controls; click opens a popover. Most native-feeling, smallest
  resting footprint — but injecting into Meet's control bar is the **highest survival
  risk** (that bar is exactly what Meet re-renders / reparents).
- **C — Edge-docked rail, right side.** Thin vertical rail of always-visible transport
  icons (colour = live/off at a glance); expands to a full panel. Different hierarchy:
  status is ambient, config is on-demand.

### 3. Survival — **NOT a variant; settled from the codebase**

Re-attaching after Meet re-renders / `<body>` swaps is a mechanism question, already
answered by the existing pattern in `src/meet/model.ts:104-146`:

- Root the `MutationObserver` on `document.documentElement` (never `<body>` — Meet
  swaps `<body>`; `<html>` is never replaced).
- On every mutation batch, coalesce via `queueMicrotask` and **re-query from scratch**
  rather than trusting cached node references.

The widget reuses this: a single host element owned by the extension, watched by a
documentElement observer that **re-appends the host if it's been detached**, plus a
full re-render of live state on reconnect. Variant A/C own their host outright (append
to `document.documentElement`, position: fixed) → the observer only needs to guard
against removal. **Variant B is the outlier**: its button lives *inside Meet's own
control bar*, so survival means re-finding that bar (by selector, via `SelectorRegistry`)
and re-injecting on every rescan — strictly more fragile and selector-drift-prone.

→ Survival cost ranks **A ≈ C  ≪  B**.

## Verdict

_(HITL — awaiting the user's pick. Fill in the chosen variant + why, then fold the
winner into the real content-script injection path and delete the losers + switcher.)_

CHOSEN: **Variant A — Floating card, bottom-right.**

WHY: Lowest survival risk (self-owned host on `<html>`, observer only guards against
removal — no re-injection into Meet's own control bar like B). Compact vertical stack of
the four groups fits the map's brief that the widget holds the *frequent in-call toggles*
and complements the Options page. C's ambient icon-strip status is appealing but leans on
live connection/device status, which the map explicitly defers (*Not yet specified*).

Implementation note surfaced by exploration (there is **no** existing DOM-injection / CSS /
Shadow DOM precedent — `src/meet/` is read-and-click only): mount the card's host in a
**Shadow DOM** wrapper appended to `document.documentElement`, so Meet's global CSS neither
leaks into nor inherits from the widget. Styles via an inline `<style>`/`adoptedStyleSheets`
inside the shadow root, not a global `content_scripts` `css:` entry.
