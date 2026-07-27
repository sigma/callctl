# Prototype — Next-Meeting key display + escalation

Throwaway prototype for **[issue #39](https://github.com/sigma/callctl/issues/39)**
(map **[#35](https://github.com/sigma/callctl/issues/35)**). Open
`index.html` directly in a browser — no build:

```
open packages/plugin/prototypes/next-meeting-key/index.html
```

## Question it answers

What does the 72×72 Stream Deck key show for the **Next Meeting** action, and how does
it **escalate** as start approaches and passes (→ flashing red when late)?

## What's in it

- **Three structurally-different variants** (bottom bar / `←`/`→` / `?variant=`):
  - **A — Countdown-primary**: big `MM:SS`, title a thin top strip. *"How long till I move."*
  - **B — Title-primary**: meeting title dominates (3 lines), urgency as a coloured pill.
    *"What is my next call."*
  - **C — Clock + draining ring**: start o'clock big, ring drains over the last hour.
    *"At what time."*
- A **live T-minus scrubber** — drag from +20 min to −3 min to watch escalation and the
  **late flash** in motion (judge the flash cadence here).
- A **filmstrip** of representative moments at true 72px size.
- **Edge states**: no more meetings today (green "Free"), and not-configured (setup prompt).

## Escalation model encoded (the proposal to react to)

Pure function of **seconds-to-start**:

| State | Threshold | Colour | Behaviour |
|-------|-----------|--------|-----------|
| normal | `> 5 min` | slate | steady |
| approaching | `≤ 5 min` | orange | steady |
| imminent | `≤ 30 s` | red | **gentle blink** (~1.2 s pulse) |
| **late** | `< 0` (past start) | **flashing red** | hard flash (~0.9 s), counts up `+MM:SS` |
| joined | extension reports in-call | — | **dismiss late state, advance to next event** |

Countdown format: `MM:SS`, switching to `Hh MM` above an hour; `+MM:SS` once overdue.
Between-meetings → green "Free"; no feed → setup prompt.

## Verdict (2026-07-27 — decided by map owner)

- **Variant A — Countdown-primary** wins: big `MM:SS`, title as a thin strip.
- Thresholds **5 min / 30 s kept**. **Imminent (≤30 s) also gently blinks** (not just late).
- Overdue **counts up `+MM:SS`** rather than freezing/hiding.
- **The late/flashing state is not open-ended:** the **extension's in-call signal is proof
  of join**, and on join the key **advances to the next event** instead of flashing forever.
  This is a *new decision that revises the map's locked "extension not involved" choice* —
  the extension becomes an optional join-detection signal (still no auto-join, logic still
  plugin-side). The plumbing + no-extension fallback is spun out to its own map ticket.

Prototype has answered its question. Fold Variant A into the real key renderer during
implementation and delete this directory then.
