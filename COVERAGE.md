# What the tests actually cover

Measured 2026-08-25 on `main`, except the mutation score, which carries its own date below. Every
number here is the output of the command beside it, run on the day given. Nothing is estimated, and
a number nobody can reproduce is not in this file.

## The suite

`npm test` runs 373 tests across 28 files inside a real Workers isolate against a real D1, in about
17 seconds. Nothing in it can reach a telephone: `vitest.config.ts` pins the mode to the local
stand-in, the API key to a string that cannot authenticate, the number to an unassigned country
code, and the only host a runbook action may call to a name that does not resolve.

## Line coverage

`npm run test:coverage`, Istanbul rather than V8 because the Workers pool does not support native
V8 coverage:

|            |        |
| ---------- | ------ |
| Statements | 72.49% |
| Branches   | 62.10% |
| Functions  | 63.68% |
| Lines      | 73.96% |

**That is a fall from 91.31% statements, and the whole of it is the dashboard.** The server halves
are where they were or better: `src/db` 98%, `src/domain` 93%, `src/actions` 93%, `src/demo` 95%,
`src/calle` 89%, `src/worker` 88%. The dashboard's screens are 2%, and the number is worth reading
in that shape rather than as one figure.

They are not untested. They are tested by something line coverage cannot see: `npm run a11y:live`
builds the bundle, drives a real browser over every screen in both themes at two widths, and asserts
against the pixels the browser painted. That runs in a different process from the instrumented one,
so none of it shows up here, and reporting a headline number that hides the distinction would be the
kind of measurement this file exists to avoid.

What line coverage DOES reach in the dashboard is the part that decides rather than draws:
`test/dashboard-logic.test.ts` covers which sentence authorized an action, which call authorized
which run, how the talk track is laid out, why the centre of the deck is empty, and how an address
is read. Those are the places where being wrong would put a false claim on the screen.

Where the server gaps are, and why they are where they are:

- `src/actions/service-state.ts` at 83% statements. Its two operations run in the loop tests, and
  what is left uncovered is the pair of branches for a rollback with nowhere to go.
- `src/calle/fake.ts` at 82%. The stand-in's own D1 store is exercised; the branch that is not is
  its in-memory store, which only a test would use.
- `src/worker/wiring.ts`. The live half is built and exercised through `test/live-loop.ts` with the
  transport replaced; what is uncovered is the branch that installs the platform's real fetch, which
  by definition cannot run in a test.
- `src/demo/history.ts` at 96%, and the uncovered lines are the two service policies the example
  estate writes only when a deployment has none of its own.

## Mutation score

`npm run mutate` (StrykerJS). A line-coverage number says a line ran; a mutation score says the
suite would have noticed if the line were wrong, which is the question worth asking of an
authorization gate.

Measured 2026-08-24: **75.62%** overall, 614 mutants killed of 785. Still the live figure on
2026-08-25: `stryker.config.json` names seven modules to mutate and this phase changed none of
them, apart from adding types to `view.ts`, which are erased before a mutant can be made of one.

| Module                      | Score  | What it decides                                    |
| --------------------------- | ------ | -------------------------------------------------- |
| `src/domain/policy.ts`      | 84.78% | Whether a telephone rings at all, and when         |
| `src/domain/decision.ts`    | 80.59% | Whether a spoken decision may change production    |
| `src/actions/parameters.ts` | 79.43% | What values reach the system being changed         |
| `src/domain/view.ts`        | 77.85% | What every screen says about a state               |
| `src/domain/incident.ts`    | 70.49% | The state machine and how an incident is described |
| `src/domain/rotation.ts`    | 32.14% | Who is called next                                 |
| `src/domain/brief.ts`       | 14.29% | What the caller says                               |

Two of those low numbers are honest rather than alarming, and one of them is a real gap:

- **`brief.ts` at 14%** is a module that is almost entirely English sentences. A mutant that
  rewrites one of them is a different sentence, not a different behaviour, and the tests assert the
  parts that ARE behaviour: the automated-systems disclosure is present, it comes before the
  incident facts, and every offered action is read out by the id a decision has to name.
- **`rotation.ts` at 32%** is mostly Zod input schemas whose validation is tested through the
  configuration API in `test/`, which the mutation run does not use. See the limit below.
- **`incident.ts` at 70%** is the real gap of the three. Its state machine is well covered; the
  descriptions read out on a call are not, and neither is every branch of the fingerprint rule.

### The limit of that score, stated rather than implied

The mutation run uses `vitest.mutation.config.ts`, which runs only the pure tests that sit beside
their modules in `src/`, in a plain Node process. It does not run anything in `test/`, because
those need a Workers isolate and a D1 database and would take hours per mutant.

So the score covers the decisions and excludes the plumbing. Not measured by it: the Durable
Object, the D1 access layer, the HTTP routes, the runbook execution engine, the CALL-E adapter, the
reconciliation sweep and every screen. Those are covered by the suite and by the accessibility gate.

## What is proven by breaking it on purpose

Neither number above is the thing this repo actually trusts. Every headline behaviour was checked
by planting a fault in the code and watching the right test go red, and the faults are named in the
README's own list. Phase 4 planted ten; two of them reddened nothing, which is how two guards that
were leaning on a neighbouring rule got tests of their own. The rules about who was heard on a call
were held to the same standard: seven faults, seven reds. The dashboard added seven more, all red:
the board route leaving the admin guard, a set token no longer meaning a token is wanted, the deck
focusing the least severe thing, the arrival trace dropping its empty buckets, an unattributed
transcript turn passed through as the responder, the deadline track running past full, and the
client-safe contract growing an import.

The accessibility gate is held to the same standard by `npm run a11y:prove`, which puts five real
defects back into the built output one at a time and expects the gate to name each one. All five are
defects this dashboard actually had on its first audit.

The demo added twelve, all red: breaking what is already broken opening a second incident, the
repair control pulling the floor out from under a call in flight, the read-only guard letting a
write through, a public demo asking for the token anyway, telephone numbers published, a demo wired
to a real telephone, a runbook action allowed its allowlist, an unreadable switch value reading as
off, seeding twice, and three on the rehearsed conversation.

**One of those twelve is why there is a finding written into the roadmap.** Making the rehearsed
responder say "Go ahead." while the decision still carries "roll it back" does not stop the action:
the authorization gate reads the confirmation phrase off the provider's extracted result and never
asks whether the transcript contains it. The loop still resolves, and only the transcript-evidence
test notices. That is a gap in the product's central claim rather than a gap in a test.

## Not covered by anything yet

- Authentication proper. Everything the dashboard reads and writes is behind one shared
  administrator token, and a retention window that deletes transcripts on a schedule does not exist
  yet. Phase 7.
- A real telephone. No call this product has placed has yet been a two way conversation, and
  `docs/two-way-audio.md` is the whole of what is known about that.
