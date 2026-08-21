# Ringbolt art direction

Locked 2026-08-21. Every screen derives from this document. Changing it is a deliberate act, not
a per-screen decision.

## The anchor

**A North Sea harbour watch room, and the International Code of Signals it runs on.**

Not "maritime" as decoration. No anchors, no ship's wheels, no rope borders. The reference is
civil port equipment built for a tired person working through bad weather at three in the morning:
painted steel cabinets, removable nameplates, blunt lettering, a movement board with slats, and a
flag locker.

The Code of Signals is the part that earns its place, because it is not styling. It is a real
communication system, still in force, for saying urgent operational things at a distance under
conditions where nothing subtle survives. It uses five colours. Each single-letter flag is a
complete message on its own.

Those messages happen to be the states this product has:

| Flag     | Its meaning at sea                     | What it means in Ringbolt                        |
| -------- | -------------------------------------- | ------------------------------------------------ |
| UNIFORM  | You are running into danger            | An alert has opened an incident                  |
| VICTOR   | I require assistance                   | The call is live                                 |
| KILO     | I wish to communicate with you         | Nobody answered, moving down the rotation        |
| CHARLIE  | Affirmative                            | The responder authorized an action               |
| NOVEMBER | Negative                               | Ringbolt refused to act, and the record says why |
| MIKE     | My vessel is stopped and making no way | A kill switch is on                              |
| LIMA     | Stop immediately                       | A destructive action is pending confirmation     |
| FOXTROT  | I am disabled, communicate with me     | The service is down and nobody has been reached  |

The flag is the state. Its meaning at sea is its meaning here. A reader who knows the code can
read the board without reading a word, and a reader who does not learns eight flags.

Flag meanings verified 2026-08-21 against the International Code of Signals as documented on
Wikipedia's international maritime signal flags article. The five colours of the system are black,
blue, red, yellow, and white.

## Type

Self-host all three as WOFF2. No runtime dependency on a font CDN.

| Role                                        | Face                                                             | Why                                                                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plates, headings, the wordmark              | **Big Shoulders Display**, 600 and 800                           | Industrial signage lineage, condensed enough to set a service name at size without shouting                                                                                                                                      |
| Everything read as language                 | **Atkinson Hyperlegible**, 400 and 700, italic for flag meanings | Drawn by the Braille Institute to stay legible for low-vision readers. The product exists for the moment when somebody is half awake and under pressure, so the body face should be the one designed for hard reading conditions |
| Timestamps, identifiers, counts, raw output | **Martian Mono**, 400 and 600                                    | Reads as a stamped log slip. Capped at roughly 15 percent of visible type, or the whole thing turns into the code-editor look                                                                                                    |

Never Inter, Roboto, or a system stack. Service names are lower case, because that is how they are
written in configuration. State plates are upper case. Transcript text stays mixed case.

## Palette

The chassis is painted port equipment. The signal colours are reserved for things that are
actually signalling, so they never lose their force.

| Token         | Hex       | Where                                                        |
| ------------- | --------- | ------------------------------------------------------------ |
| Chassis ochre | `#d99a16` | The dominant surface, roughly 60 percent of the interface    |
| Chassis deep  | `#a8760c` | The watch beam, the side rail, incident headers              |
| Log           | `#ffeec2` | Reading surfaces: transcripts, forms, evidence               |
| Harbour ink   | `#172b29` | Text, rules, borders                                         |
| Tide green    | `#0a665e` | Completed actions, healthy state                             |
| Signal blue   | `#14568c` | Ringbolt's own spoken lines and machine-written evidence     |
| Signal red    | `#c8202a` | Ringing, failure, and the exact words that granted authority |
| Signal yellow | `#ffc400` | Waiting, and the accent in the wordmark                      |

No gradients. No translucency. No glass. Ochre stays visibly dominant, and red appears in short
sharp bursts rather than as a second brand colour.

**Night watch** is a real theme, not a filter, because the product's own use case is nocturnal.
Chassis becomes `#123330`, deep `#0b2321`, reading surfaces `#17403c`, and text `#f3e7c6`. Signal
colours lift for contrast: blue `#6fb2e8`, red `#ff6b62`, tide `#46b3a4`. Yellow does not change.

A note earned the hard way: text on the deep chassis needs its own token, not the reading-surface
colour. Reusing the reading-surface token made the entire header and side rail unreadable in night
watch, and the rendered screenshot is what caught it. `--on-deep` exists for that reason.

## Structure

The application is one continuous **watch board**. It is not a sidebar wrapped around a grid of
cards, and it never becomes a uniform grid.

- A **watch beam** 104px tall crosses every screen: the time, who is on the line, and four
  removable plates, Watch, Incidents, Lines, Authority.
- Incidents are **full-width slats**, read left to right: flag, service and failure, what the flag
  means, who is being called, what state the action is in. Row height follows urgency. A waiting
  incident is one line.
- The incident currently on the telephone opens into a **working bay** that interrupts the rack.
  Its transcript is set at full reading size, not shrunk into a notification.
- An **event track** runs along the bottom edge showing the last ninety minutes.
- The right-hand rail carries the code of signals, the incident's own evidence, and the call
  allowance.

### The incident bay, which is the one screen that matters

The call is laid out along a single horizontal **time rail**. Ringbolt speaks above the rail in
signal blue. The human speaks below it in ink. This is a spoken record, not a chat thread, so
turns are placed along time rather than stacked as bubbles.

The words that granted permission are set in signal red, and a red **tie** runs from that box down
into the action docket beneath. The docket spans the full width: proposed action, spoken authority,
confidence, stages, result.

That tie is the whole product in one graphic. The action and the sentence that permitted it cannot
be read as two separate events, because they are physically joined on the page.

### Motion

Motion behaves like heavy equipment being operated, never like software being cute.

- A new incident opens its slot in 120ms, then drives the slat in over 240ms,
  `cubic-bezier(.22,.78,.15,1)`.
- Controls depress by 2px in 80ms. Nothing floats up on hover.
- The ringing marker flashes exactly twice, then holds solid.
- Provisional transcript words appear pale and lock to full colour one phrase at a time.
- Authorization draws the tie, then latches inward over 100ms. That latch is the moment execution
  becomes possible.
- Execution advances through discrete stops. No ornamental spinner.
- No bounce, no elastic easing, no parallax, no ambient motion. Sound only after deliberate input.
- All of it respects `prefers-reduced-motion`, which cuts duration to zero rather than removing the
  state changes.

## Real media

The load-bearing imagery is the **flag set**, drawn as SVG from the real geometry of the
International Code of Signals. It is real in the sense that matters here: it is an existing
system with existing meanings, reproduced accurately, not an illustration invented to fill space.

The incident page's other real medium is the **call itself**. Actual word timing sets the transcript
layout, actual silences show as gaps, and the evidence strip holds the real monitoring output,
deploy identifiers, and timestamps captured during that incident. Never a stand-in graphic.

Explicitly not doing: commissioned night photography of working quays. It would suit the anchor and
it does not exist, so nothing in this product depends on it. A plan that names media nobody has
shot is a plan to ship a placeholder.

## How this direction was chosen

Two directions were produced independently, rendered as working HTML at the same size, and
screenshotted before being judged. Both are kept in `design/bakeoff/`.

- **A, signal code** (`bakeoff/a-signal-code.png`). Near-black chassis with the flag system as the
  state language. Handsome and legible, and structurally it is the default operations dashboard.
  Anyone shown it would readily believe a machine designed it, which is the test it had to pass.
- **B, watch room** (`bakeoff/b-watch-room.png`). The ochre chassis, the slat rack, the time rail
  and the authorization tie. Braver and structurally distinctive. Two faults: the night window was
  a CSS gradient standing in for a photograph, which is the abstract-decoration tell, and its media
  plan depended on photography nobody has taken.

The locked direction takes B's chassis and skeleton, replaces its invented imagery with A's flag
system, and swaps the display face for one with less novelty in it. Rendered in
`mockups/board-day.png` and `mockups/board-night.png`.

## Still to draw

Mockups exist for the watch board only, in both themes. The incident detail page, the authority
matrix, and the rotation watch bill have no mockup yet and are the next design work. Nothing here
claims a screen that has not been rendered.
