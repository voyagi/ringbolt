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

Two values are plain configuration and live in `wrangler.jsonc` under `vars`:

| Name              | What it does                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `RINGBOLT_ENV`    | `development`, `preview`, or `production`. Outside development, an intake token is required. |
| `PUBLIC_BASE_URL` | The deployed URL. CALL-E sends its webhooks here, so it has to be the real one.              |
| `CALLE_MODE`      | `fake` dials nothing and is the default. `live` places real phone calls.                     |

Two are secrets and are set with `wrangler secret put`, never written to a file in this
repository:

```bash
wrangler secret put CALLE_API_KEY   # from https://dashboard.heycall-e.com/account/api-keys
wrangler secret put INTAKE_TOKEN    # any long random string, used in the intake URL
```

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

Send `fingerprint` if your monitor has a stable identifier for the underlying problem. Without one
Ringbolt groups by service and title, which is coarser: two genuinely different problems that
share a title will be treated as one incident, and only the first will ring a phone.

## Going live with real calls

Set `CALLE_MODE=live` only once `CALLE_API_KEY` is set and `PUBLIC_BASE_URL` is reachable from the
internet. In live mode every incident that clears the policy places a real phone call to a real
person, and the account's call allowance is finite. `/api/budget` reports what has been spent.
