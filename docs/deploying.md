# Deploying Ringbolt

Ringbolt runs on Cloudflare Workers. Everything it needs is inside the free plan: Workers for the
service, D1 for the records, and Durable Objects with the SQLite backend for the per-incident
lifecycle and its timers.

## One-time setup

```bash
wrangler login
wrangler d1 create ringbolt
```

Copy the `database_id` that command prints into `wrangler.jsonc`, replacing the local development
placeholder. Then apply the schema:

```bash
npm run db:migrate:remote
```

## Configuration

Three values are plain configuration and live in `wrangler.jsonc` under `vars`:

| Name                    | What it does                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `RINGBOLT_ENV`          | `development`, `preview`, or `production`. Outside development, an intake token is required.   |
| `PUBLIC_BASE_URL`       | The deployed URL. CALL-E sends its webhooks here, so it has to be the real one.                |
| `CALLE_MODE`            | `fake` dials nothing. `live` places real calls. See below.                                     |
| `LIVE_CALL_ALLOWLIST`   | Every number a live build may ring, comma separated. `DEMO_PHONE` is always included.          |
| `ACTION_HOST_ALLOWLIST` | Every host a runbook action may call, comma separated. Outside development, empty means none.  |
| `CALLE_CREDIT_USD`      | What this deployment may spend on real calls. Empty means nothing, and nothing is the default. |

The rest are secrets, set with `wrangler secret put` and never written to a file in this repository:

```bash
wrangler secret put INTAKE_TOKEN    # any long random string, used in the intake URL
wrangler secret put ADMIN_TOKEN     # any long random string, guards /api/config
wrangler secret put DEMO_PHONE      # the number Ringbolt calls, in E.164, live mode only
wrangler secret put RUNBOOK_SECRET_DEPLOY   # one per system an action may change, see below
```

A cron trigger runs once a minute and is declared in `wrangler.jsonc`, so `wrangler deploy` sets it
up. It is the backstop behind the per-incident alarms: it wakes any incident whose alarm was lost,
closes one that is waiting for nothing, and clears out expired webhook event ids.

`INTAKE_TOKEN` is what stops a stranger opening incidents and making your phone ring, so treat it
as a credential and rotate it if it leaks. `ADMIN_TOKEN` is stronger than that: it guards the
endpoints that decide whose number gets dialled. Outside development those endpoints refuse to
serve at all until it is set, so a deployment that forgets it is locked rather than open.

## Policy, contacts, and the rotation

Everything an operator configures lives under `/api/config`, and every request there carries
`Authorization: Bearer $ADMIN_TOKEN`.

```bash
# who can be called
curl -X POST https://your-worker-url/api/config/contacts \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Kim","phone":"+31612345678"}'

# the order they are called in, for one service or for '*', which is the shared rota
curl -X PUT https://your-worker-url/api/config/rotation/checkout \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"contactIds":["con_first","con_second"]}'

# what wakes somebody for this service, and what may be offered on the call
curl -X PUT https://your-worker-url/api/config/services/checkout \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"minSeverity":"high",
       "quietHours":{"startMinute":1320,"endMinute":420,"zone":"Europe/Amsterdam","minSeverity":"critical"},
       "allowedActions":["kill_switch"],
       "flapWindowMinutes":15,"maxCallsPerWindow":1,"escalateAfterMinutes":3}'
```

| Field                  | What it does                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `minSeverity`          | Below this, the alert is recorded and nobody is telephoned.                               |
| `quietHours`           | Minutes from local midnight in a named IANA zone, and the severity that still rings.      |
| `allowedActions`       | The action ids that may be read out on a call for this service.                           |
| `flapWindowMinutes`    | How far back Ringbolt looks when deciding whether this problem already rang a phone.      |
| `maxCallsPerWindow`    | How many calls that window is allowed to contain. One is what makes one problem one call. |
| `escalateAfterMinutes` | How long a call has to produce something before the next person is tried.                 |

A service with no policy of its own calls about everything, keeps no quiet hours, permits every
action, and allows one call per fifteen minutes. A service with no rotation of its own uses `*`, and
with no rotation at all `DEMO_PHONE` is who gets called. `GET /api/config/actions` lists the action
ids a policy may name; a policy naming one this build does not have is refused rather than quietly
narrowing what a responder is offered.

## What may be carried out on a call

An action is a row rather than a function, so adding one is a request and not a deploy. The two the
product ships with change state Ringbolt owns; anything that reaches your own systems is written
down here.

```bash
curl -X PUT https://your-worker-url/api/config/actions/restart_workers \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
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

| Field                | What it does                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `spokenDescription`  | Read out on the call, so it is a sentence a person can answer rather than a function name.     |
| `confirmationPhrase` | The exact words that have to be said back. Leave it null for anything not destructive.         |
| `minConfidence`      | A floor of its own, above the product-wide one, for an action that deserves more certainty.    |
| `parameters`         | Values the responder can give out loud, each with a type that is checked before anything runs. |
| `target`             | `service_state` for state Ringbolt owns, or `http` for a request to one of your systems.       |
| `verify`             | A read of the system afterwards. Without one, nothing confirms the change took effect.         |

Three rules are worth knowing before writing one. A credential goes in a `RUNBOOK_SECRET_*` binding
and is named by the definition, never typed into it, because this endpoint can read definitions
back. The host has to be in `ACTION_HOST_ALLOWLIST` or the request is refused before it is sent.
And an action that is retried has to say `"idempotent": true`, because a request that never came
back may have been carried out anyway.

An action whose `verify` disagrees with it is recorded as `unverified`, and an unverified action
does not resolve the incident. `GET /api/audit/incidents/{id}` returns the whole record: the
transcript, the decision, who authorized it, the values they gave, and the system either side of
the change. It carries personal data, so it is behind `ADMIN_TOKEN` like the rest.

## Deploy

```bash
npm run verify:ship
npm run deploy
```

## Pointing a monitor at it

Any monitor that can send an HTTP POST works. The body is plain JSON:

```bash
curl -X POST https://your-worker-url/intake/$INTAKE_TOKEN \
  -H 'content-type: application/json' \
  -d '{"service":"checkout","title":"Payment errors above 20 percent","severity":"critical"}'
```

`service` and `title` are required. `severity` is one of `critical`, `high`, or `low` and defaults
to `high`. `detail`, `source`, `fingerprint`, `startedAt`, and `links` are optional.

`startedAt` is an ISO timestamp and it is worth sending: it is read out on the call as a duration,
which is the first thing a responder asks. `links` are stored with the incident.

Send `fingerprint` if your monitor has a stable identifier for the underlying problem. It groups
repeats into one incident and it also decides which owner handles them, so a stable value gives one
phone call for one broken thing however the title varies between alerts. Without one, Ringbolt
groups by service and title, which is coarser: two genuinely different problems that share a title
are treated as one incident, and only the first rings a phone.

## Real calls

Live mode reaches an actual telephone and costs money. CALL-E bills five cents per call task
created, connected or not. Read `/api/budget` before switching it on: it reports what has been
spent and what is left, counted from the ledger row written when a call is accepted.

```bash
wrangler secret put CALLE_API_KEY   # from https://dashboard.heycall-e.com/account/api-keys
wrangler secret put DEMO_PHONE      # E.164, for example +31612345678
```

Then set `CALLE_MODE` to `live` in `wrangler.jsonc`, set `CALLE_CREDIT_USD` to what you are
prepared to spend, and deploy. Six things have to be true before a call can happen, and each is
refused separately rather than failing at the moment a phone should ring:

1. `PUBLIC_BASE_URL` is the deployed URL, because that is where CALL-E delivers the outcome. A
   webhook that cannot be delivered leaves the sweep to recover the call a few minutes later.
2. `CALLE_API_KEY` is set. Configuration is refused without it, and `/health` says so.
3. `DEMO_PHONE` is set and is a valid E.164 number. It is who gets called when no rotation has been
   configured, and it is always allowed to be dialled.
4. The number being dialled is on the list. A live build rings only `DEMO_PHONE` plus whatever
   `LIVE_CALL_ALLOWLIST` names, comma separated and each in E.164. The rotation can name any contact
   anybody adds through the configuration endpoint, so without this the set of telephones a
   deployment can reach would be a database table rather than something an operator wrote down. A
   number that is not on it is refused and nothing is sent to CALL-E.
5. `CALLE_CREDIT_USD` is set to something. It defaults to nothing, so a live build that has not
   been told what it may spend spends nothing, and says so rather than failing obscurely.
6. `LIVE_MODE_AVAILABLE` in `src/worker/env.ts` is `true`. Set it to `false` to take the whole
   build off the telephone regardless of what any environment says, which is worth doing when
   something is looping and the money matters more than the alerts.

Once the credit is spent, placing a call is refused with the figures in the message and nothing is
sent to CALL-E. Reading calls back keeps working, so incidents already in flight still finish.

Two more things happen on this path, and both were learned the expensive way on 2026-08-22, when
this build created twenty-three separate call tasks in half an hour.

**There is a ceiling on the rate, not only on the total.** At most three real calls in ten minutes,
refused before anything is sent. Each of those twenty-three was a different logical call, so no
per-call check could have refused any of them.

**A create that times out is not a create that did not happen.** The call can already have been
accepted, and CALL-E confirmed that a repeat carrying a different idempotency key is billed as a
second, independent call to the same person. So a failed create is sent once more with the same
key, which returns the call the first one made rather than making another. If neither send can be
settled, the incident is closed with `call_outcome_unknown` and the record says a call may exist
that Ringbolt cannot see, which is your cue to look at their dashboard before trying again.
