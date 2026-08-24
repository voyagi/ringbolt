# Runbook

What to do when Ringbolt itself is the thing that has gone wrong. Written 2026-08-24. Every command
here was run, or is quoted from the vendor documentation named beside it on that date.

`docs/deploying.md` is how to stand it up. This is how to keep it alive, get it back, and turn it
off.

## What it is made of

| Piece                           | What it does                                                                        | What happens without it                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The Worker                      | Intake, webhooks, the read and configuration API                                    | Nothing works. Alerts get a connection error and no incident exists                    |
| D1 (`ringbolt`)                 | Every incident, event, call record, action run, contact and policy                  | The Worker answers and nothing persists. Treat as total outage                         |
| One Durable Object per incident | The state machine, the exclusive section, the alarm that escalates                  | Incidents open and never move: no escalation, no call back after a snooze              |
| The cron trigger, once a minute | The backstop that wakes incidents whose alarm was lost and clears expired event ids | Lost webhooks are never recovered. Slow decay rather than an outage                    |
| CALL-E                          | The telephone                                                                       | Incidents open, calls are refused, and every refusal is recorded. No alerting by phone |

The first check for any of these is `GET /health`, which reports the configuration it actually
parsed rather than a hardcoded `ok`.

## The data, and which of it is personal

- `contacts` and the `LIVE_CALL_ALLOWLIST` hold telephone numbers.
- `call_records` holds transcripts: what a named person said out loud, at a timestamp.
- `action_runs` holds who authorized a production change, by name.

All three are personal data under the GDPR. The audit endpoint that reads them is behind
`ADMIN_TOKEN`. Retention and deletion are phase 7 and are not built yet, which is stated in the
README rather than left to be discovered.

## Backups

Two legs, because they fail differently.

**On-platform: D1 Time Travel.** Cloudflare keeps a continuous restore window with no action from
you: 7 days on the free plan, 30 days on a paid plan. Verified on
[developers.cloudflare.com/d1/reference/time-travel](https://developers.cloudflare.com/d1/reference/time-travel/)
on 2026-08-24. It only applies to databases on D1's production backend; `wrangler d1 info ringbolt`
prints a `version` field, and `production` is the one that has it.

```bash
wrangler d1 time-travel info ringbolt          # the current bookmark, and how far back you can go
```

Time Travel is inside the same account as the database it protects, so it covers a bad migration or
a delete. It does not cover losing the account.

**Off-platform: a scheduled export.** `.github/workflows/d1-backup.yml` runs
`wrangler d1 export ringbolt --remote` on a schedule and keeps the dump as a build artifact, which
is a different platform from the one holding the database. It is off until the repository variable
`D1_BACKUP_ENABLED` is set to `true` and a `CLOUDFLARE_API_TOKEN` secret exists, and it fails loudly
rather than skipping quietly if it is enabled without them. Until that switch is on, the only
backup is Time Travel, and that is a decision rather than an oversight.

Run one by hand at any time:

```bash
wrangler d1 export ringbolt --remote --output ringbolt-$(date +%F).sql
```

## Restoring

**A bad write, a bad migration, a wrong delete.** Time Travel, and it is the fastest answer:

```bash
wrangler d1 time-travel restore ringbolt --timestamp=UNIX_TIMESTAMP
# or, from the bookmark `time-travel info` printed before the damage:
wrangler d1 time-travel restore ringbolt --bookmark=BOOKMARK_ID
```

**A lost account, or a dump you want to load into a fresh database.** The export is a plain SQL
file, so the restore is an import:

```bash
wrangler d1 execute ringbolt --remote --file ringbolt-2026-08-24.sql -y
```

**Rehearsed, not assumed.** `node scripts/restore-rehearsal.mjs` does the whole thing against the
LOCAL database: it seeds 2000 incidents, exports, drops every table, imports the export, and
compares the row count either side. It refuses to run any command that does not carry `--local`.

Measured on 2026-08-24, on this machine, with 2010 rows and a 984 KB dump:

| Step                                   | Time         |
| -------------------------------------- | ------------ |
| Export                                 | 2.0 seconds  |
| Every table dropped                    | 2.3 seconds  |
| Import, and the row count back to 2010 | 34.1 seconds |

The import is the slow half by a factor of seventeen, and it grows with the row count rather than
with the file size. That is the number to plan a real restore around: a database a hundred times
this size is an hour, not a minute, and the incidents arriving during it are not being called
about.

## Rolling the code back

```bash
wrangler versions list           # what has been deployed
wrangler rollback [version-id]   # go back to one
```

**One hard limit, and it is permanent for this product.** A rollback is refused when a Durable
Object class lifecycle change has happened between the active version and the one you are rolling
back to, per
[developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/),
verified 2026-08-24. Ringbolt declares the `INCIDENT` Durable Object in its first migration, so once
that has been deployed there is no rolling back past it. Deploying a fix forward is the only route,
and a change to the Durable Object is therefore the one change worth being slow and careful about.

Rolling the code back does NOT roll the data back. They are separate systems and separate commands,
in that order: restore the data, then decide about the code.

## When something is wrong

**No calls are being placed.** In order: `/health` for the configuration, `/api/budget` for the
money, then the incident's own events, which record every refusal with its reason. The common ones
are a credit of zero (a live build spends nothing until `CALLE_CREDIT_USD` is set), the rate ceiling
of three calls in ten minutes, and a number that is not on `LIVE_CALL_ALLOWLIST`.

**A call was placed and the incident never moved.** The webhook did not arrive or could not be
processed. The cron sweep recovers this within a minute or two on its own. To force it in
development, `npm run dev:scheduled` and hit `/__scheduled`. If it recurs, `PUBLIC_BASE_URL` is
probably not the deployed URL.

**An incident says `call_outcome_unknown`.** A create was sent twice under one idempotency key and
neither send could be settled, so a call may exist that Ringbolt cannot see. Check the CALL-E
dashboard before doing anything else, and expect to be billed for it.

**An action ran and the incident did not resolve.** That is `unverified`: the request succeeded and
the check that was supposed to confirm it disagreed. The system was probably not changed. Read
`action_runs` for the state either side, and do not re-run the action on the assumption it failed.

**The responder was not heard.** The refusal is `responder_not_heard` and no action ran.
`docs/two-way-audio.md` is the whole of what is known about that fault.

## Rotating a credential

Every one of these is a `wrangler secret put` followed by a deploy, and each has a different blast
radius:

| Secret             | What it protects                 | What breaks while it is wrong                                                               |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `CALLE_API_KEY`    | The telephone and the money      | Every call is refused. Incidents still open and record                                      |
| `INTAKE_TOKEN`     | Who may open an incident         | Monitors get a 401 and alerts are silently lost. Change the monitors first, then the secret |
| `ADMIN_TOKEN`      | Who may change whose phone rings | The configuration API refuses. Nothing else is affected                                     |
| `RUNBOOK_SECRET_*` | One system an action may change  | That action fails and the incident stays open for a person                                  |

## What this depends on that is not ours

- **CALL-E** for every call. No status page is relied on: the product's own record of refusals and
  failures is the signal, and a call that cannot be placed closes its incident rather than leaving
  it open to swallow the next repeat of the alert.
- **Cloudflare Workers, D1, Durable Objects and cron triggers.** A Cloudflare outage is a total
  outage of this product, and the honest mitigation is that alerts stop being answered rather than
  being answered wrongly.
