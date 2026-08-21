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
2. Policy decides whether this is worth waking anybody: the service's severity threshold, its quiet
   hours, whether the same problem has already rung a phone recently, and which remediation actions
   may be put on the call.
3. It places a call through CALL-E to whoever is at the top of that service's rotation, carrying the
   incident facts and a result schema that forces a structured decision back rather than a paragraph
   of prose.
4. The responder asks whatever they need to, then says what to do.
5. The decision is verified before anything happens. Only then does the action run.
6. Incident, transcript, decision, authorizer, action, and the system state before and after all
   land in one record.
7. Nobody picks up, and the next person in the rotation is called instead.

A webhook that never arrives does not lose the decision. Every incident Ringbolt parks carries the
time it is due to be looked at again, and its own Durable Object holds an alarm for that time: a
call that nobody answers, a snooze the responder asked for, quiet hours that have ended. A sweep
runs once a minute behind all of that as the backstop for an alarm that was lost with the isolate
that set it, and it wakes an incident by calling the identical code the alarm would have called.
Nothing an incident can do leaves it stuck, because an incident that is stuck is an alert that has
silently stopped ringing.

One step of that list is still ahead of the code, and the Status section below says where it is:
runbook actions are hardcoded rather than defined by an operator.

## One broken thing is one phone call

Three separate rules, because a pager that cries wolf gets ignored, and an ignored pager is worse
than no pager.

**Repeats collapse.** While an incident is open, every repeat of the same alert attaches to it. The
grouping is the sender's own fingerprint when it sends one, and service plus title when it does not,
and it is enforced by a unique index rather than by a check in application code.

**A service that flaps is suppressed.** Once an incident closes, the next repeat is compared against
the calls already placed about that exact problem inside a window. Past the allowance for that
window it opens an incident, records that it did, and telephones nobody. When the window rolls off,
the suppressed incident closes rather than turning into a late call: it exists because that problem
already rang a phone, and ringing an hour afterwards is the thing suppression is for. The next
repeat after that is judged afresh.

**Quiet hours hold, they do not drop.** An alert below the severity that is allowed to break a
service's quiet hours is parked until the window ends and then called about, in the window's own
time zone. An unresolvable zone rings rather than holds, because the wrong way to fail on a
configuration mistake is silence.

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

Use `npm run dev:scheduled` instead if you want to trigger the reconciliation sweep by hand at
`/__scheduled`, which is how you watch a lost webhook get recovered without waiting for the cron.

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

A live build also dials only numbers named in `LIVE_CALL_ALLOWLIST`, plus `DEMO_PHONE`, which is
always on the list. A rotation can name any contact anybody has added, so without that the set of
telephones a deployment can reach would be a database table rather than something an operator wrote
down.

## Who gets called

Contacts and rotations live under `/api/config`, which is the whole of the configuration surface:
service policy, contacts, rotations, and the actions a policy may permit.

```bash
curl -X POST http://localhost:8787/api/config/contacts \
  -H 'content-type: application/json' \
  -d '{"name":"Kim","phone":"+31612345678"}'

curl -X PUT http://localhost:8787/api/config/rotation/checkout \
  -H 'content-type: application/json' \
  -d '{"contactIds":["con_...","con_..."]}'
```

A service with no rotation of its own uses the shared one, named `*`. With no rotation at all,
`DEMO_PHONE` is who gets called, so a fresh install still rings somebody rather than requiring the
rota to be built before it can do anything.

Those endpoints decide whose telephone rings, so outside development they refuse to serve until
`ADMIN_TOKEN` is set, and then require it as a bearer token. That is a floor rather than the
finished answer: real authentication is still ahead, and the Status section says so.

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

The behaviour is held to the same standard. Every claim above that a suite is supposed to defend
was checked by breaking the code on purpose and watching the right test go red: escalating to the
person already on the call, reusing one idempotency key across attempts, letting one more call
through the suppression window, and never arming the alarm at all.

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

The loop runs end to end against the local stand-in: an alert becomes an incident, policy decides
whether it is worth a call, a call is placed to whoever is on the rota, the decision that comes back
is verified and authorized, the authorized action changes state that can be read back, and a call
nobody answers moves to the next person on a timer. The CALL-E adapter is built and switchable on,
and it satisfies the same contract suite as the stand-in.

Not built yet, and not pretended to be:

- Runbook actions as configuration. The two that exist are defined in code, not by an operator, and
  a policy can only choose between them.
- The dashboard. The API is there; the screens are not.
- Authentication and per-tenant isolation. `/api/config` is guarded by one shared admin token, and
  the read API is open. Both are stated here rather than left for somebody to discover.

## Licence

MIT. See `LICENSE`.
