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

Every step of that list runs. What is still ahead of the code is the screens rather than the
mechanism, and the Status section below says exactly where.

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
completed, the task was completed, confidence clears the floor, the decision validates against the
requested schema, the named action was actually offered on that call and is still permitted by that
service's policy, the values the responder gave fit what the action declared it accepts, and, for
anything destructive, the responder said the confirmation phrase. An individual action can demand
more confidence than the product-wide floor. Any one of those failing is a refusal with a reason,
recorded, not an error swallowed.

**And silence cannot authorize anything.** A call has to carry at least one thing the responder
actually said before any of the above is even considered. A transcript where only Ringbolt was
heard is refused as `responder_not_heard`, and a turn the provider could not attribute to anybody
does not count towards it. This is not a hypothetical: every call this product has placed so far
came back with the responder's turns present and empty, and such a call can still report the task
completed at high confidence with a schema-valid decision in it. `docs/two-way-audio.md` has the
evidence, what was ruled out, and what a live call would settle.

One honest limit on that floor, worth stating rather than leaving implied. The confidence number
CALL-E returns is its confidence that the task was completed, not its confidence in the specific
decision it extracted. So the floor filters calls that went badly, and it does not measure how
sure the transcription is about the word the responder actually said. The schema check, the
offered-action check and the spoken confirmation phrase are what guard the decision itself.

And a second limit on the last of those, found by planting a fault rather than by reading the code.
The confirmation phrase is checked against the field CALL-E extracted, not against the transcript,
so an action can run on a phrase that appears nowhere in what the responder is recorded as saying.
The deck already holds the stricter rule: it marks a sentence as the authorization only when that
sentence really contains the words. Making the gate ask the same question is the next thing on this
path, and until it does, the claim here is that the provider reported the phrase rather than that
the recording contains it.

## What Ringbolt is allowed to do

An action is a row, not a function. It carries what it is called, the sentence the caller reads out
about it, the exact words that have to be said back before it runs, the values it accepts, what it
actually does, and how to check afterwards that it worked. Adding one is a `PUT`, not a deploy.

```bash
curl -X PUT http://localhost:8787/api/config/actions/restart_workers \
  -H 'content-type: application/json' \
  -d '{"label":"Restart the workers",
       "spokenDescription":"restart the workers, which drops every job in flight",
       "confirmationPhrase":"restart the workers",
       "minConfidence":0.85,
       "parameters":[{"name":"reason","description":"why, in their own words","type":"string"}],
       "target":{"kind":"http","method":"POST",
                 "url":"https://deploy.harbourworks.net/checkout/restart",
                 "headers":{"x-api-key":{"fromSecret":"RUNBOOK_SECRET_DEPLOY"}},
                 "body":{"reason":"{reason}"}},
       "verify":{"url":"https://deploy.harbourworks.net/checkout/health",
                 "jsonPath":["status","healthy"],"equals":true}}'
```

Two kinds of target. **service_state** changes something Ringbolt owns, which is what makes the
demo real without anybody's credential. **http** reaches another system, and that path is written
on the assumption that the request changes production:

- HTTPS only, on the ordinary port, with no credentials in the url.
- No address literals and no names that only exist inside a network, so the cloud metadata endpoint
  is not reachable through a definition somebody typed in.
- Redirects are not followed. The host was authorized; a redirect is the target choosing another
  one afterwards.
- A response is read up to a bound rather than swallowed whole.
- One attempt, unless the definition says running it twice is the same as running it once. A
  request that never came back may have been carried out anyway.
- Credentials are named bindings, never values in the row. Only a binding called `RUNBOOK_SECRET_*`
  can be read, so a definition cannot reach the CALL-E key or the admin token.
- The hosts a deployment may reach at all are in `ACTION_HOST_ALLOWLIST`, which is deployment
  configuration rather than a database table. That is the same argument as the phone allowlist, and
  it is also the answer to a public name that resolves to a private address, which a Worker cannot
  otherwise defend against.

**Values are typed, and the type is the guardrail.** A number spoken over a telephone arrives as
words, so each value is checked against what the action declared it accepts and refused if it does
not fit, rather than coerced into whatever the request would have taken. A value the action never
asked for is a refusal too.

**An action that cannot be confirmed does not resolve the incident.** A service_state action is
always read back. An http action is checked when its definition says how, and if the request
succeeded while the check disagrees, the run is recorded as `unverified` and the incident stays
open for a person. Telling somebody a production problem is fixed because a request returned 200 is
a claim about the request, not about the system.

Every run lands in one record: the transcript, the decision, who authorized it, the values they
gave, how many attempts it took, and the system state either side of the change.

```bash
curl -H "authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8787/api/audit/incidents/inc_...
```

That endpoint is behind the admin token because a transcript is personal data and because it is the
evidence behind a production change.

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

Or watch it happen at <http://localhost:8787>, which is the point of the next section.

## The deck

The dashboard is one screen with a primary instrument: a ring counting the seconds somebody has
been on the telephone, with everything that decides whether this is bad arranged around it. The
centre column is the call, and the sentence that granted permission is joined by a red rule to the
action it allowed, so the two cannot be read as separate events. The right column is everything not
on the phone, and the rota, so "who gets called next" is always answered on screen.

Five more screens: the history of every incident, one incident in full with its transcript and the
system state either side of every action, the runbook and the per-service policy, the rota, and the
demo service with the control that breaks it.

Three things about it are worth stating because they are decisions rather than defaults.

**Nothing on it is drawn from data Ringbolt does not have.** It consumes alerts and transcripts; it
is not a monitoring tool. So there is no audio waveform and no error-rate chart, because it has
neither. What it draws instead are the two series it genuinely holds: the talk track, every
transcript turn at its own offset coloured by who was speaking, and the arrival trace, alerts
landing for that service in five minute buckets. The mark saying which sentence authorized an action
appears only on a turn whose words really contain the phrase that action required, matched the same
way the authorization gate matches it. When nothing in the transcript proves it, nothing is marked.

**It polls rather than holding a socket.** The board aggregates across every incident and each
incident is owned by its own Durable Object, so a socket would mean new state on the path that
decides whether a telephone rings, added for a screen. It reads every two seconds and counts the
ring against the server's clock rather than the browser's, because a laptop several minutes out is
ordinary and a call that reads as having run for minus four minutes reads as a bug in Ringbolt.

**It is behind the administrator token**, because it carries transcripts and because its
configuration screens decide which telephone rings. In development with no token set it is open,
which is a laptop talking to itself; everywhere else it asks for `ADMIN_TOKEN` and says so plainly
rather than showing a spinner.

Accessibility is measured rather than asserted. `npm run a11y:live` builds the bundle, drives a real
browser over every screen in both themes at two widths, runs axe against WCAG 2.1 AA, treats an
undetermined result as a failure, and measures contrast from the pixels the browser actually painted
on every control and on the dial's own readout. It is a step in `npm run verify:ship`. Its first run
found thirty violations, and `npm run a11y:prove` puts five of them back one at a time and expects
the gate to name each one.

Screenshots of every screen in both themes are in `design/mockups/`, regenerated from the built
bundle by `node scripts/render-screens.mjs`.

To place real calls, set `CALLE_MODE=live` with a `CALLE_API_KEY`, a `DEMO_PHONE` in E.164, and the
`CALLE_LOCALE` and `CALLE_REGION` the call will be held in, for example `en-GB` and `NL`.
Configuration is refused if any of them is missing, so `/health` tells you before an alert does.
`docs/deploying.md` has the full procedure.

The last two are optional to CALL-E and required here, which is a deliberate difference:
`docs/two-way-audio.md` explains what happened on the calls that were placed without them.

CALL-E bills per call task created, at five cents, whether or not it ever connects. So a live build
spends nothing until `CALLE_CREDIT_USD` says what it may spend, `/api/budget` reports what is left
in money rather than in calls, and the adapter refuses and sends nothing once that is gone. Reading
calls back keeps working either way, so incidents already in flight still finish.

There is a second ceiling, on the rate rather than the total: at most three real calls in ten
minutes. It exists because of a real half hour on 2026-08-22 in which this build created
twenty-three separate call tasks. Every one of them was a different logical call, so no per-call
check could have refused any of them, and the thing that was wrong was how fast they were arriving.

That half hour also taught the other rule on this path. A create that times out is not a create
that did not happen: the call can already have been accepted, and a repeat carrying a fresh
idempotency key is billed as a second call to the same person. So a failed create is sent once
more with the SAME key, which returns the call the first one made, and if neither send can be
settled the incident says a call may exist rather than reporting a clean failure.

A live build also dials only numbers named in `LIVE_CALL_ALLOWLIST`, plus `DEMO_PHONE`, which is
always on the list. A rotation can name any contact anybody has added, so without that the set of
telephones a deployment can reach would be a database table rather than something an operator wrote
down.

## The demo

There is one service in the estate that belongs to Ringbolt: `dockside`, a checkout that can be
broken on purpose. Its health is read from the same table a runbook action writes, so breaking it is
a row, fixing it is a row, and the thing that fixes it is the ordinary `rollback` action a responder
authorizes on a call rather than a shortcut written for the demo.

Press the button on `/demo` and the product runs: a bad release goes out, the demo service's own
watch posts an alert, policy decides it is worth a call, the call is placed to whoever is on the
rota, the responder asks what else is affected and then says the words the rollback demanded, and
the release is put back. The deck draws a line from that sentence into the action it allowed. Half a
minute later the demo screen reads SERVING again, without anybody reloading it.

It refuses the things it should. Breaking what is already broken is refused rather than opening a
second incident, four presses are one telephone call because repeats collapse the way any monitor's
repeats do, and the service cannot be put back by hand while a call about it is in flight, because
that would leave the record claiming a rollback for a service somebody had already quietly fixed.

**A deployment with `DEMO_MODE` set is public and read only**, and it is the worker that enforces
that rather than a screen declining to draw a button:

- It cannot be in live mode. The two together are a configuration error and the deployment refuses
  to serve at all, so no stranger can cause a telephone to ring.
- Every write is refused except the demo controls, the intake endpoint, which still carries its own
  token, and the CALL-E webhook, which is verified against the provider before it is believed.
- No runbook action is allowed any host at all, so the only thing an action can change is state
  Ringbolt owns.
- Telephone numbers are withheld from every read. Names stay: a name is who authorized a production
  change, and that is the record. So a demo must be its own deployment with its own database, and
  `docs/deploying.md` says so in those words.

A demo deployment is seeded with six incidents so nobody meets the product as an empty screen: a
call that ended in a rollback, a call the responder held, an alert the policy refused to ring
anybody about, one that ran out of people to escalate to, and two still open. One of them is the
call nobody was heard on, carrying a schema-valid instruction to change production at high
confidence, refused. That is the most important thing in the seeded history and it is why it is
there.

## What the person on the phone is told

Every call opens by saying it is Ringbolt and that it is an automated system rather than a person,
before any of the incident facts. It is one of the instructions in the brief that goes out with the
call, so there is no setting that turns it off, and a test asserts it is there and that it comes
first.

That is EU AI Act Article 50(1), which has applied since 2 August 2026. The determination, and the
three neighbouring paragraphs that do not apply and why, are in `docs/ai-act.md`.

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

Development runs against a fake CALL-E rather than the real one, because every real call costs
money and rings somebody's telephone. The fake is deliberately awkward: the call is
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
through the suppression window, never arming the alarm at all, dropping an action's own confidence
floor, ignoring the host allowlist, resolving an incident on a change nothing could confirm,
retrying a request that may already have been carried out, and substituting a spoken value into a
request as text rather than into the structure. The rules about who was heard on a call were held
to the same standard: counting whitespace as speech, counting an unattributed turn as the
responder, removing the check, handing the gate a transcript the orchestrator made up, dropping the
locale or the region from the outgoing call, and dropping the disclosure from the brief each turn
the right test red.

Two of those planted faults changed nothing, which was worth more than the ones that worked: both
guards were being covered by a different rule rather than by a test of their own, and both now have
one.

The demo added thirteen, all red: breaking what is already broken opening a second incident, the
repair control pulling the floor out from under a call in flight, the read-only guard letting a
write through, a public demo asking for the administrator token anyway, telephone numbers published
on one, a demo wired to a real telephone, a runbook action allowed its allowlist, an unreadable
switch value reading as off, the example history seeded into a rota somebody is on call for,
seeding it twice, and three on the conversation the stand-in rehearses.

The dashboard added seven more, all of which reddened the right test: the board route leaving the
administrator guard, a set token no longer meaning a token is wanted, the deck focusing the least
severe thing on the phone instead of the worst, the arrival trace dropping its empty buckets so a
quiet hour looks like a busy one, an unattributed transcript turn passed through as the responder,
the deadline track running past full on an overrun, and the client-safe contract module growing an
import, which is the one thing that would let server code into the browser bundle past a boundary
rule that would still report clean.

## Layout

| Path          | What is in it                                                                              |
| ------------- | ------------------------------------------------------------------------------------------ |
| `src/domain`  | The incident state machine, the decision contract, and the orchestrator. No platform code. |
| `src/calle`   | The telephone port, the CALL-E adapter, the local stand-in, and the verification step.     |
| `src/demo`    | The one service Ringbolt owns and can break, and the example estate a demo is seeded with. |
| `src/actions` | What an action definition may say, and the two engines that carry one out.                 |
| `src/db`      | The D1 schema access layer.                                                                |
| `src/worker`  | Routing, configuration, the incident Durable Object, and the deck's one read.              |
| `src/ui`      | The dashboard. It may import `src/domain/view.ts` and nothing else under `src`.            |
| `design`      | The art direction, and a screenshot of every screen in both themes.                        |
| `docs/adr`    | Why the stack is what it is.                                                               |
| `docs`        | Deploying it, the runbook for when it breaks, and the two open questions it has.           |

## Status

The loop runs end to end against the local stand-in: an alert becomes an incident, policy decides
whether it is worth a call, a call is placed to whoever is on the rota, the decision that comes back
is verified and authorized, the authorized action changes a real system and is checked afterwards,
and a call nobody answers moves to the next person on a timer. Actions are configuration, so what
can be authorized on a call is something an operator writes down rather than something a deploy
decides. The CALL-E adapter is built and switchable on, and it satisfies the same contract suite as
the stand-in.

One thing has not been proven on a real telephone, and this is the place to say so rather than
leave it to be discovered: no call this product has placed has yet been a two way conversation.
Ringbolt was heard on all of them and the responder was not. The product's answer to that is to
refuse to act on such a call, which is tested; the cause is still open, and
`docs/two-way-audio.md` says exactly how far the evidence goes and what the next live call would
settle.

The demo runs too: a stranger can open a `DEMO_MODE` deployment, break the demo service, and watch
the whole loop from the alert to the rollback, with no way to make a telephone ring and no write
that reaches anything else.

Not built yet, and not pretended to be:

- Authentication and per-tenant isolation. Everything the dashboard reads and writes is behind one
  shared administrator token, `/api/incidents` is open, and there is no retention window that
  deletes a transcript on a schedule. All three are stated here rather than left for somebody to
  discover.

## Licence

MIT. See `LICENSE`.
