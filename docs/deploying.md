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

| Name              | What it does                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `RINGBOLT_ENV`    | `development`, `preview`, or `production`. Outside development, an intake token is required. |
| `PUBLIC_BASE_URL` | The deployed URL. CALL-E sends its webhooks here, so it has to be the real one.              |
| `CALLE_MODE`      | `fake` dials nothing. `live` places real calls. See below.                                   |

Two are secrets, set with `wrangler secret put` and never written to a file in this repository:

```bash
wrangler secret put INTAKE_TOKEN    # any long random string, used in the intake URL
wrangler secret put DEMO_PHONE      # the number Ringbolt calls, in E.164, live mode only
```

A cron trigger runs once a minute and is declared in `wrangler.jsonc`, so `wrangler deploy` sets it
up. It re-reads any call that has not reported back and clears out expired webhook event ids.

`INTAKE_TOKEN` is what stops a stranger opening incidents and making your phone ring, so treat it
as a credential and rotate it if it leaks.

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

Live mode reaches an actual telephone, and the CALL-E free tier is twenty calls in total with no
way to buy a twenty first. Read `/api/budget` before switching it on: it reports how many have been
placed and how many are left, counted from the ledger row written when a call is accepted.

```bash
wrangler secret put CALLE_API_KEY   # from https://dashboard.heycall-e.com/account/api-keys
wrangler secret put DEMO_PHONE      # E.164, for example +31612345678
```

Then set `CALLE_MODE` to `live` in `wrangler.jsonc` and deploy. Four things have to be true before a
call can happen, and each is refused separately rather than failing at the moment a phone should
ring:

1. `PUBLIC_BASE_URL` is the deployed URL, because that is where CALL-E delivers the outcome. A
   webhook that cannot be delivered leaves the sweep to recover the call a few minutes later.
2. `CALLE_API_KEY` is set. Configuration is refused without it, and `/health` says so.
3. `DEMO_PHONE` is set and is a valid E.164 number. Ringbolt dials this number and no other until
   the rotation lands.
4. `LIVE_MODE_AVAILABLE` in `src/worker/env.ts` is `true`. Set it to `false` to take the whole
   build off the telephone regardless of what any environment says, which is worth doing when
   something is looping and the remaining allowance matters more than the alerts.

Once the allowance is spent, placing a call is refused with the count in the message and nothing is
sent to CALL-E. Reading calls back keeps working, so incidents already in flight still finish.
