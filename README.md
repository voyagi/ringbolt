# Ringbolt

The on-call line that phones a human when production breaks, talks the incident through with
them, and then carries out the fix they authorize out loud.

A ringbolt is the iron ring bolted into a quay that a ship ties to in a storm.

## Why this exists

Every on-call tool can already phone you. None of them can have a conversation.

PagerDuty's own documentation describes what its phone alert is: a text-to-speech message
followed by keypad codes, press 4 to acknowledge, 6 to resolve, 8 to escalate. That is the state
of the art. At 3am it tells you something is broken and then hands you a laptop-shaped problem.
You cannot ask what broke. You cannot ask what else is affected. You cannot fix anything from the
call.

Ringbolt makes the call two-way and gives it hands. It explains the incident, answers questions
about it, and executes a remediation on your spoken authorization, with the whole exchange kept as
the audit record of who authorized what.

## How it works

```
alert  ->  policy  ->  phone call  ->  spoken decision  ->  authorization  ->  action  ->  audit
```

1. Any monitor posts an alert to an intake endpoint. The payload is plain JSON, so a curl works.
2. Repeats of the same problem collapse into one incident, and the remediation actions that may be
   offered for that service are read out on the call.
3. It places a call through CALL-E, carrying the incident facts and a result schema that forces a
   structured decision back rather than a paragraph of prose.
4. The responder asks whatever they need to, then says what to do.
5. The decision is verified before anything happens. Only then does the action run.
6. Incident, transcript, decision, authorizer, action, and the system state before and after all
   land in one record.

A webhook that never arrives does not lose the decision. A sweep re-reads any call that has not
reported back: one that finished is carried through exactly as the webhook would have, and one that
never finished is handed to escalation rather than left sitting there. Nothing an incident can do
leaves it stuck, because an incident that is stuck is an alert that has silently stopped ringing.

Two steps of that list are still ahead of the code, and the Status section below says where they
are: the routing policy that decides whether an alert is worth a call at all, and the rotation that
moves to the next person when nobody answers.

## Two properties this is built around

**A webhook cannot authorize anything.** CALL-E delivers its terminal events unsigned, with no
shared secret. Its own SDK marks the signature helpers deprecated for that reason. A product that
changes production systems cannot treat an unauthenticated POST as an instruction, so Ringbolt
reads the call back from the CALL-E API under its own key and acts on that snapshot instead. The
rule is enforced by the type system: the code that authorizes an action accepts a `VerifiedCall`,
and the only thing that can produce one is the function that fetched it.

**A guess cannot authorize anything either.** Speech is lossy. An action runs only when the call
completed, the task was completed, confidence clears a floor, the decision validates against the
requested schema, the named action was actually offered on that call, and, for anything
destructive, the responder said the confirmation phrase. Any one of those failing is a refusal
with a reason, recorded, not an error swallowed.

One honest limit on that floor, worth stating rather than leaving implied. The confidence number
CALL-E returns is its confidence that the task was completed, not its confidence in the specific
decision it extracted. So the floor filters calls that went badly, and it does not measure how
sure the transcription is about the word the responder actually said. The schema check, the
offered-action check and the spoken confirmation phrase are what guard the decision itself.

## Running it

```bash
npm install
npm run db:migrate:local
npm run dev
```

That starts against a local stand-in for CALL-E, so nothing dials a telephone. Fire an alert at
it:

```bash
curl -X POST http://localhost:8787/intake/dev \
  -H 'content-type: application/json' \
  -d '{"service":"checkout","title":"Payment errors above 20 percent","severity":"critical",
       "detail":"Error rate went from 0.2 percent to 23 percent after the 14:02 deploy."}'
```

The incident appears, a call is placed, the stand-in answers with a decision, and the resulting
action changes state you can read back:

```bash
curl http://localhost:8787/api/incidents
curl http://localhost:8787/api/services/checkout/state
```

To place real calls, set `CALLE_MODE=live` with a `CALLE_API_KEY` and a `DEMO_PHONE` in E.164.
Configuration is refused if either is missing, so `/health` tells you before an alert does.
`docs/deploying.md` has the full procedure.

The CALL-E free tier is twenty calls in total and there is no twenty first, so the allowance is
enforced rather than documented. `/api/budget` reports what is left, the adapter refuses to place a
call once the count is reached and sends nothing when it refuses, and reading calls back keeps
working so incidents already in flight still finish.

## The local stand-in

Development runs against a fake CALL-E rather than the real one, because every real call spends
part of an allowance that cannot be topped up. The fake is deliberately awkward: the call is
asynchronous, the outcome arrives as a webhook carrying almost nothing, and the real state has to
be fetched back. Anything that passes against it and then fails against the real API is a gap in
the fake, not a surprise from the vendor. It stores its calls in the database rather than in
memory, because the code placing a call and the code receiving the webhook run in different
isolates, and an in-memory fake would quietly pass a test the real integration fails.

That argument is only worth anything if the two are actually interchangeable, so both are held to
one suite. `test/placer-contract.test.ts` is written against the interface rather than against
either implementation, and each of them is run through every case in it. The CALL-E adapter is
exercised there with its transport replaced, so the real adapter, the real SDK, and the real
request building all run, and only the network is missing.

## Verifying it

```bash
npm test            # the suite
npm run gate        # types, complexity, duplication, boundaries, ship artifacts
npm run verify:ship # everything, one command, with per-step exit codes
```

The gates were each proven to fail on a planted violation before being trusted: a
thirty-one-branch function, a pasted block, an import cycle, and a type error each turn their gate
red, and the clean tree passes all four.

## Layout

| Path          | What is in it                                                                              |
| ------------- | ------------------------------------------------------------------------------------------ |
| `src/domain`  | The incident state machine, the decision contract, and the orchestrator. No platform code. |
| `src/calle`   | The telephone port, the CALL-E adapter, the local stand-in, and the verification step.     |
| `src/actions` | Runbook actions and their guardrails.                                                      |
| `src/db`      | The D1 schema access layer.                                                                |
| `src/worker`  | Routing, configuration, and the incident Durable Object.                                   |
| `docs/adr`    | Why the stack is what it is.                                                               |

## Status

Early. The loop runs end to end against the local stand-in: an alert becomes an incident, a call is
placed, the decision that comes back is verified and authorized, and the authorized action changes
state that can be read back. The CALL-E adapter is built and switchable on, and it satisfies the
same contract suite as the stand-in.

Not built yet, and not pretended to be:

- Routing policy. Every alert places a call, and every service is offered the same two actions.
- Contacts and rotation. There is one number, so a call nobody answers goes to no one else.
- The dashboard. The API is there; the screens are not.

## Licence

MIT. See `LICENSE`.
