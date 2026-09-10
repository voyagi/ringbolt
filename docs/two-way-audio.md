# The call nobody has been heard on

Written 2026-08-24. Ringbolt's whole product is a two-way conversation, and no call it has placed
has ever been one. This is what is known, what was ruled out, what changed because of it, and the
one test that would settle the rest.

## What was observed

Twenty-three call tasks were created on 2026-08-22 against one owned number. Every one of them came
back the same way:

- Ringbolt's turns carried text and duration.
- The recipient's turns were present in the transcript and carried no text and no duration.
- The task was reported completed on several of them, with a confidence score in the nineties.

The vendor was deliberately not asked about it, so that it can be tested rather than reported as a
guess.

## What was ruled out, and how

| Explanation                              | Ruled out by                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| The handset was faulty or muted          | A different caller was heard on the same handset inside the same window            |
| Two calls were colliding on one line     | The first attempt ran alone for 1m16s and failed identically                       |
| The transcript was simply not returned   | Turns for the recipient WERE returned; they were empty, which is a different thing |
| Ringbolt hung up before the person spoke | Attempts ran for over a minute with the line open                                  |

## What was not ruled out

Both of these remain open, and only a live call can separate them:

1. **No inbound audio reached CALL-E at all.** One way audio is the classic carrier and routing
   fault, and the calls were placed without ever telling CALL-E which country the telephone was in.
   Their API documents `region` as "used for routing and compliance checks".
2. **Audio arrived and was not recognised.** The calls were also placed without a locale, which
   their API documents as the "BCP 47 locale hint for the conversation". A recogniser hinted at the
   wrong language can return empty text for perfectly audible speech.

Both share one cause on this side: the client sent neither field. That is the part this repo can
fix, and it has.

## What changed

**Every call now says what language it is in and which country the telephone is in.**
`CALLE_LOCALE` and `CALLE_REGION` are required in live mode, so the build refuses to start rather
than place another call that leaves them out. `test/live-placer.test.ts` asserts both are on the
wire.

**A call the responder was never heard on cannot authorize anything.** The authorization gate now
refuses with `responder_not_heard` unless the transcript carries at least one turn attributed to
the recipient with text in it. A turn attributed to `unknown` does not count: that is the
provider's own uncertainty about who was speaking, and this is not a place to accept a guess.

This is the more important half. Whatever the audio fault turns out to be, a call in that state can
still report the task completed with high confidence and a schema-valid decision in it, and every
other check in the gate would pass it. Without this guard, a production system would have been
changed on the strength of a conversation only one side of took place.

The refusal escalates rather than closing the incident, because a channel this broken is exactly
what a human should be told about. The rate ceiling, three real calls in ten minutes, bounds what
that costs if the fault is not specific to one call.

**The stand-in can reproduce it.** `CALLE_FAKE_SCENARIO=one_way_audio` produces the observed
transcript shape paired with the most dangerous remainder it could carry: task completed, high
confidence, a valid decision to turn checkout off. `test/one-way-audio.test.ts` runs the whole loop
on it and asserts nothing ran, nothing changed, the refusal is in the record, and the one sided
transcript is kept as evidence. A control test runs the identical decision on a call where the
responder was heard, and that one does change the system.

Seven faults were planted across these guards and each reddened the right test, including one where
the orchestrator hands the gate a transcript it made up rather than the call's own.

## The live test that would settle it

This needs credit and it needs the owner. The balance is minus $0.15 and each call task costs five
cents whether or not anybody speaks, so this is one deliberate call, not a debugging session.

1. Set `CALLE_LOCALE` and `CALLE_REGION` in `.dev.vars` to match the phone being called, for
   example `en-GB` and `NL`. Set `CALLE_CREDIT_USD` to the top-up amount and nothing more.
2. Place one call by the procedure under "Real calls" in `docs/deploying.md`. Answer it and say
   something ordinary early, before Ringbolt has finished its opening sentence, then answer
   normally.
3. Read the call back from the API and look at the transcript.

What the result means:

- **Recipient turns now carry text.** The missing locale or region was the fault, and the product
  works. Record which of the two it was by trying the other on the next call if it matters.
- **Recipient turns are still empty.** The fault is below this client, in the audio path itself.
  Ringbolt's own behaviour is already correct, since it refuses rather than acting, and the next
  step is the vendor, with the transcript and the call ids as evidence rather than a guess.

Either way the guard stays. It is not a workaround for this fault; it is the rule that a decision
needs somebody to have made it out loud.

## 2026-09-08: refused before it dialled

The balance was topped up on 2026-09-08 and the live test above was attempted with `CALLE_LOCALE`
and `CALLE_REGION` set. It never rang. CALL-E refused the create with "result_schema is not
supported", no call task was made, nothing was billed, and the incident closed as
`call_place_refused`.

The cause was on this side, and it was neither the locale nor the region. CALL-E's extraction
takes a subset of JSON Schema, spelled out in their API contract from version 0.7.1: `type`,
`properties`, `required`, `enum`, nested objects, simple array items, `description`, and
`additionalProperties: false`. It refuses `$ref`, `oneOf`, `anyOf`, `allOf`, format validation and
`additionalProperties: true`. The decision contract had described `action_parameters` as an object
with any string keys since 2026-08-22, which is an `additionalProperties` that is neither absent
nor false. Their message names the field and not the feature; the reason sits under
`details.reason` in the response, which the adapter did not record.

Three things changed:

- The contract is built per call by `decisionResultSchemaFor` in `src/domain/decision.ts`. It
  names each value the offered actions ask for as its own text field, and leaves
  `action_parameters` out when nothing on the call asks for one.
- `src/calle/schema.ts` holds the check for their supported subset, and both placers run it before
  anything is stored or sent. The stand-in now refuses what CALL-E refuses, so the suite, which
  runs the real contract through it, goes red on the old shape. Before this it was green.
- A refusal from CALL-E is recorded with their `details.reason` and error code, so the next one
  names its cause in the incident's own record.

What this changes about the table above: nothing. The audio question is still open, because no
call has yet been placed with the locale and region set. The 23 silent calls were created on
2026-08-22 and `action_parameters` entered the contract the same day; whether they went out under
the open-ended shape is not recorded here, and it does not bear on the question, since they
connected and were transcribed. The live test stands as written, and its next attempt is the first
one that can answer it.

## 2026-09-08, second attempt: accepted, then refused for the region

With the contract fixed, the same test was run again the same evening. CALL-E accepted the create
(`call_3Iea9VhkLFrtbAb9088nQw`, 15:30:24Z) and nineteen seconds later marked the task failed with
the code `call_not_ready` and this sentence, read back through their CLI:

> Call task creation was rejected: Calls to the Netherlands in English are not supported for this
> call setup. Which supported region/language combination should be used instead if you want to
> continue?

The recipient stayed `pending` with no attempts, so nothing was dialled and no telephone rang. Their
published region table lists the Netherlands, `+31`, English, in the "International" tier, which
their note describes as "primarily intended for testing". Two other reports on their tracker from
the same weekend say the same of Spain and of Indonesia, both also "International" (call-e-integrations
issues 116 and 118), each for a combination the table lists. The refusal is on their side, and it
has been reported to them with the call id.

What this does to the question above: it cannot be answered from a Dutch number until CALL-E dials
the Netherlands again. It also reframes the 23 silent calls. They were placed with neither a region
nor a language, and a planner that now refuses this combination outright may then have been placing
them with a setup it did not support. That is consistent with one-way audio. It is still not proof.

What changed in the code: a call's record now carries the sentence CALL-E writes beside its failure
code, so the next refusal explains itself on the incident page. This one read "The call ended."
while the sentence above sat unread in the API response, and it took a read by hand to learn why
nobody was called.

## 2026-09-10, CALL-E's answer: the question stays open, and not by our choice

The refusal was reported to CALL-E on two channels: a public issue on their integrations tracker
(number 121, where a repository collaborator marked it P1 the following night and asked their
platform owner to audit the billing path) and an email to their support address carrying the account
details the public issue deliberately left out. Support answered on 2026-09-10:

> Netherlands/English is blocked for the setup you reported. We cannot confirm an available language
> for Dutch destinations or restoration by September 13, so please plan around that limitation.

They pointed at their own documentation, which does say it. Read on 2026-09-10, the region page
still lists the Netherlands with English in the International tier, under the sentence "Some
destinations listed below may be temporarily restricted". So the table is not wrong so much as
incomplete: it publishes what is offered and not what is currently reachable. On this task the
difference showed up only once the task had been created and come back failed, and not when it was
asked for. That is one observation and not a rule about their API.

They also asked that the task not be retried, and said they have not yet verified the charge or a
reversal for the task that never dialled. So whether this particular one was billed is not settled
either, and this document does not treat it as spent money until they say so.

**What that settles.** The question at the top of this document cannot be answered here. Answering
it needs a call that reaches a Dutch telephone, CALL-E would not confirm that the route would be
restored by September 13, and they asked that the task not be retried. That is not the same as a
promise that it stays down, and it is enough to close the question for this entry rather than leave
it waiting on a call nobody can schedule. The 23 silent calls of 2026-08-22 keep the reading given
above, which is a plausible explanation and not a proven one, and this document will not claim more
than that.

**What it does not touch.** Every rule the calls were placed under held while the provider failed.
Ringbolt refused to act on a call that never happened, closed the incident, and now writes the
provider's own sentence onto the incident's record instead of "The call ended." A product whose
whole argument is that it will not act on words nobody said has to behave that way when its
telephone line is the thing that breaks, and that is the part this episode actually tested.
