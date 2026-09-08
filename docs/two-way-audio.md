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
