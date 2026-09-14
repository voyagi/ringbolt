# A walk through the public demo, in words

Everything below happens on [ringbolt.taranity.com](https://ringbolt.taranity.com), the public
demo. It needs no install, no account and no key, and nothing you press there can make a telephone
ring: that deployment answers calls with Ringbolt's local stand-in rather than dialling.

This is the same walkthrough the video linked from the README shows, written out so you can read it
in a minute instead of watching it.

## The deck

When production breaks at three in the morning, your on-call tool can ring you. But that call? It
is a recording. Press four to acknowledge. Press six to resolve. And to find out what actually
broke, you still have to get out of bed, and find a laptop.

This is Ringbolt. It phones the engineer on call, has a real conversation about the incident, and
then carries out the fix they authorize, out loud.

## Breaking something on purpose

This is the public demo. Nothing here can ring a phone, so the call you are about to watch is
Ringbolt's local stand-in, running the same loop as the live build. Dockside is a service Ringbolt
owns. Bad release, going out now.

> On `/demo` this is the control labelled **Break dockside**. The readout beside it turns to
> FAILING and the service raises its own alert, which goes through the same orchestrator every
> other alert does. The one thing it skips is the HTTP intake endpoint, because that needs the
> intake token and this control has to work for a stranger with no credentials at all. So intake
> authentication, rate limiting and payload validation are not what this walkthrough exercises.

## The call

The alert comes in. Policy decides it is worth waking somebody up, and Ringbolt calls. The
responder hears what broke, and authorizes the rollback in their own words.

> The ring on the deck counts the seconds somebody has been on the line.

## What has to be true before anything runs

Before Ringbolt believes a word of that call, it fetches it again from the provider, because
webhooks carry no signature. The decision has to match a schema, clear a confidence floor, and name
an action the policy already allowed. And the exact words have to be in the transcript.

> On the record screen, a red rule joins the sentence that granted permission to the action it
> allowed, so the authorization and the change cannot be read as two separate events.

The rollback ran, and dockside is healthy again.

## The call that was refused

Voice is a lossy channel, so Ringbolt never acts on a guess. This example call came back completed,
at high confidence, with a valid decision to change production. It never ran. Not one word from the
person who answered was transcribed. No evidence, no action.

The real telephone path is built too. What stopped it is narrower than it sounds: the provider
refused the call setup Ringbolt reported, with the words "Calls to the Netherlands in English are
not supported for this call setup", while their own published region table still lists that
destination. The repository treats that as one observation rather than a rule about their API, and
records it with the call ids in [docs/two-way-audio.md](../docs/two-way-audio.md).

## The rest of the rota

A responder can also hold, snooze, or escalate. Policy filters out what should not ring anybody.
Quiet hours wait. And when nobody answers, the next person on the rota gets the call.

## Go and break it

The demo is public. Break it yourself. Nothing you press there can ring a phone.

Ringbolt.
