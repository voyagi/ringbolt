# Ringbolt art direction

Locked 2026-08-21, second round. The first direction was rejected by the owner as "too boring and
too old style", and that rejection was correct. Every screen derives from this document. Changing
it is a deliberate act, not a per-screen decision.

## The anchor

**A modern instrument cluster.** The reference is the glass cockpit and the pit wall: a dense,
precise, high-contrast surface built so that one person under pressure can read the whole state of
a system in a glance and act on it.

Not "dashboard" as a generic word. The specific thing that makes an instrument cluster different
from a dashboard is that it has a **primary instrument**. There is one dial your eye lands on
first, and everything else is arranged around it as supporting readout. Most software dashboards
have no primary instrument at all, which is why they read as a wall of equal-weight boxes.

Ringbolt's primary instrument is the live call. A ring counts the seconds someone has been on the
phone. Nothing else on the screen competes with it.

## Type

Self-host all as WOFF2. No runtime dependency on a font CDN.

| Role                                    | Face                      | Why                                                                                                                                                   |
| --------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything read as language             | **Sora**, 400 / 600 / 700 | Geometric with slightly unusual letterforms, so it reads current without reading like every product launched this year. Not Inter, not a system stack |
| Numbers, times, identifiers, raw output | **Chivo Mono**, 400 / 700 | Tabular figures that hold their column while a timer runs. Used for anything that changes, so a moving number never shifts the layout                 |

Service names are lower case, because that is how they are written in configuration. Small labels
are upper case with wide tracking, the way an instrument panel labels its readouts. Body text stays
mixed case.

## Palette

Dark by default, because the product's own moment is nocturnal, and a light theme that is a real
theme rather than an afterthought.

| Token              | Night     | Day       | Where                                              |
| ------------------ | --------- | --------- | -------------------------------------------------- |
| deck               | `#0d1420` | `#f2f5fa` | The ground everything sits on                      |
| panel              | `#141d2c` | `#ffffff` | Raised readouts: the docket, the fact grid         |
| edge               | `#23314a` | `#d5dde9` | Every dividing line, and the grid gaps             |
| on-deck / on-panel | `#e8eef8` | `#101828` | Text, named per surface                            |
| dim                | `#8695ad` | `#5d6b82` | Labels and secondary text                          |
| live               | `#ff3d71` | `#e5003f` | The call, and the words that authorized an action  |
| cyan               | `#22d3ee` | `#0a7ea4` | Ringbolt's own voice, and machine-written evidence |
| green              | `#29e08a` | `#067a4a` | A completed action, a healthy service              |
| amber              | `#ffb020` | `#a86400` | Waiting, no answer, escalating                     |
| violet             | `#a78bfa` | `#6d3fd4` | Queued, about to call                              |

Five semantic colours, not one accent on black. That distinction matters: a single acid accent on
near-black is the default every tool ships. Here each hue means one specific state and is never
used decoratively, which is what an instrument panel does and what a styled dashboard does not.

No gradients, no glass, no translucency, no glow beyond the single ring pulse on the live marker.

**Every surface names its own text colour.** In the first direction a reading-surface colour was
reused for text on a dark panel, and the entire header and side rail became unreadable in one
theme. Reading the CSS did not catch it and the rendered screenshot did. Hence `--on-deck` and
`--on-panel` as separate tokens from `--deck` and `--panel`.

## Structure

Three columns under a thin bar, with a stat strip pinned to the bottom. The page never scrolls the
whole board: each column owns its own overflow.

**Left, the primary instrument.** The service name, the ring counting the live call, then the facts
that decide whether this is bad: severity, what is affected, the error rate against its baseline,
and a sparkline of the last twenty-five minutes. The ring is the only large circular element
anywhere in the product, so it can never be confused with anything else.

**Centre, the call.** A waveform where Ringbolt's voice, the human's voice, and the moment of
authorization are three distinct colours. Then the conversation. Then the action docket. Then a
plain timeline of what Ringbolt actually did and when.

**Right, everything not on the phone.** Standing incidents as small metered units, each with a
coloured spine for its state and a progress track. The rota sits at the bottom, so the question
"who gets called next" is always answered on screen.

### The tie

A red rule runs from the sentence that granted permission down into the action cell beneath it, and
that cell carries a red top edge to receive it.

This is the whole product in one graphic. The action and the words that allowed it are physically
joined on the page, so they cannot be read as two separate events. It survived from the rejected
direction because it was the one part of it that was right.

### Motion

Motion reads like an instrument responding, never like software being cute.

- The live ring advances continuously. The inner cyan arc tracks progress through the call's goal.
- The line-open marker pulses twice on connect, then holds solid. It does not blink forever.
- A new incident's unit slides into the standing column over 240ms,
  `cubic-bezier(.22,.78,.15,1)`. Nothing floats on hover, controls depress 2px in 80ms.
- Provisional transcript words appear dim and lock to full colour one phrase at a time.
- Authorization draws the tie downward, then the action cell's top edge lights. That is the moment
  execution becomes possible and it gets its own beat.
- Execution advances through discrete stages. No ornamental spinner anywhere.
- `prefers-reduced-motion` cuts every duration to zero and keeps every state change.

## Real media

The load-bearing visuals are all **measured data rendered honestly**: the call's real waveform with
real speaker attribution, the real error-rate sparkline, the real timeline with real timestamps.

That is a deliberate position rather than a shortage of ideas. This product's credibility is that
it tells you exactly what happened and what it did about it, so decorative imagery would work
against it. Nothing here is a placeholder graphic standing in for something that was never built.

## How this direction was chosen

Round one anchored on a 1970s harbour watch room. The owner rejected it as too boring and too old,
and they were right on both counts: the anchor was a period piece, so it looked like one, and every
element was a flat rectangle in muted ochre with no depth and no sense of anything happening.

Round two produced three directions, rendered as working HTML at the same size and screenshotted
before any of them was judged. All three are kept in `design/bakeoff2/`.

- **C, pit wall** (`bakeoff2/c-pitwall.png`). A light motorsport timing board. Clean and modern,
  and the closest of the three to an ordinary dashboard, so the weakest answer to "boring".
- **D, broadcast** (`bakeoff2/d-broadcast.png`). Electric blue with enormous type, like live
  television. The boldest, and arguably too loud for something you meet at 3am.
- **E, instrument.** Chosen by the owner. Rebuilt here with two faults from the candidate fixed:
  the empty lower half now carries the fact grid, the sparkline and the timeline, and the
  authorization tie now visibly connects to the action cell instead of floating.

Round one's rejected candidates stay in `design/bakeoff/` as a record of what was tried.

Rendered: `mockups/board-day.png` and `mockups/board-night.png`, from `mockups/board.html`.

## Still to draw

The watch board only, in both themes. The incident history view, the runbook and authority
screens, and the rota have no mockup yet and are the next design work. Nothing in this document
claims a screen that has not been rendered.
