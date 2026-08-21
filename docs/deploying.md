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
| `CALLE_MODE`      | `fake` dials nothing and is the only value this build accepts. See below.                    |

One is a secret and is set with `wrangler secret put`, never written to a file in this repository:

```bash
wrangler secret put INTAKE_TOKEN    # any long random string, used in the intake URL
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

This build cannot place one. `CALLE_MODE=live` is refused when the configuration is read, so
`/health` answers `ok: false` and says why, rather than accepting the setting and then failing every
intake. The CALL-E adapter is the next piece of work; when it lands, this section gets the go-live
procedure and `/api/budget` reports what the finite call allowance has been spent on.

There is therefore no point setting `CALLE_API_KEY` yet. Nothing reads it until live mode exists,
so `wrangler secret put CALLE_API_KEY` belongs to that same piece of work rather than to this
setup.
