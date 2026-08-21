# ADR 0001: Runtime, storage, and application stack

Status: accepted
Date: 2026-08-21

## Context

Ringbolt receives alerts over HTTP, places outbound phone calls through the CALL-E Developer API,
waits an unbounded amount of wall-clock time for a human to answer and finish talking, then runs an
outbound remediation action and records an audit trail. A dashboard renders all of this live.

Four properties drive the choice, and only the first two are ordinary web-app properties.

1. A dashboard with a real design ceiling. The interface is the product's face and it is judged.
2. Cheap, simple deploy on a free tier. There is no budget for this project.
3. **Durable, precise timers.** Escalation is the feature: if the person on call does not pick up
   within a set number of seconds, the next person must be called. That is a per-incident timer
   that has to survive process restarts and fire at a specific moment, not on a polling sweep.
4. **A long-lived async lifecycle per incident.** One incident owns a state machine that runs for
   minutes, receives webhooks out of order, must never place the same call twice, and must fan its
   state out to any dashboard watching it.

Properties 3 and 4 are the ones that eliminate options. Everything can serve a dashboard.

## Options considered

### Next.js on Vercel with Neon Postgres

The familiar choice, and the strongest on design tooling and deploy simplicity. It loses on
property 3. Vercel functions are request-scoped, so an escalation timer has to become a row with a
`due_at` column plus a cron job sweeping it. Vercel's free plan runs cron at a coarse granularity,
which turns "escalate after 45 seconds" into "escalate somewhere in the next minute or two". For a
product whose entire pitch is what happens in the first minute of an incident, that is the wrong
place to be imprecise. It also means the incident state machine lives as rows plus a sweeper rather
than as one owner, which is where double-call bugs come from.

### Node with Fastify on a small always-on host

Solves the timer problem trivially with an in-process scheduler, and loses on properties 2 and 4.
Free always-on hosting is either gone or comes with cold-start suspends that break the timer
guarantee it was chosen for. A single process is also a single point of failure holding
in-memory incident state.

### SvelteKit or Remix on Cloudflare

Same runtime advantages as the choice below, with the app framework doing more of the work. Ruled
out on a narrower point: this product's front end is a live operational board driven by a socket,
not a set of server-rendered documents, so the framework's server-rendering strengths go unused
while its conventions still constrain how the Worker is structured. There is no SEO surface behind
the login to justify server rendering.

### Cloudflare Workers with Durable Objects and D1 (chosen)

Durable Objects are the exact primitive properties 3 and 4 describe. One Durable Object per
incident is a single-threaded actor that owns that incident's state machine, so concurrent webhooks
serialize against one owner instead of racing rows. Its `alarm` API is a durable timer that fires
at a specific time, survives restarts, and needs no sweeper. It can hold the dashboard's WebSocket
connections and push state as the call progresses.

Verified on Cloudflare's own documentation on 2026-08-21, because the free tier is load-bearing
here: Durable Objects are available on the Workers free plan with the SQLite storage backend, and
free-plan accounts are not charged for that storage. D1 free allowance is 5 GB with 5 million rows
read and 100 thousand rows written per day. Workers free allows 100 thousand requests per day with
10 ms CPU per invocation, which is generous for this workload because time spent waiting on a
network call is not CPU time.

## Decision

- Runtime: Cloudflare Workers, TypeScript throughout.
- HTTP layer: Hono, for a small typed router that runs natively on Workers.
- Incident lifecycle: one Durable Object per incident, owning the state machine, the escalation
  alarm, and the WebSocket fan-out to connected dashboards.
- Queryable storage: D1, for everything the dashboard lists and filters across incidents.
- Front end: React with Vite, served as static assets from the same Worker, talking to the Hono API
  and to the incident socket.
- Validation: Zod at every boundary, including the Worker's `env` binding.

## Consequences

Accepted costs, stated rather than discovered later:

- Two storage systems. D1 is the queryable record and a Durable Object holds live lifecycle state.
  The rule that keeps this honest is that D1 is the source of truth for anything a human reads
  after the fact, and the Durable Object is the source of truth only while an incident is live.
- No server-side rendering, so the dashboard is a client-rendered application. Acceptable because
  every page sits behind authentication and none of it should be indexed.
- Local development runs on workerd through Wrangler rather than plain Node, so anything assuming a
  Node built-in needs checking against the Workers runtime.
- `@t3-oss/env-core` from the shared gate set is deliberately not installed. It validates
  `process.env` at boot, and Workers deliver configuration per request through the `env` binding,
  so it cannot run. The same guarantee is met by parsing `env` with a Zod schema at the edge of the
  request handler, which is wired in and tested.
- The bundle-size gate is pointed at the client asset directory only. A Workers build emits the
  server bundle into the same output tree, and measuring that would report a number that means
  nothing about what a browser downloads.

## What would invalidate this

- If escalation timing stopped mattering, the Durable Object layer would be unjustified complexity
  and rows plus a cron sweep would be the simpler correct answer.
- If Durable Objects left the free plan, or the SQLite backend stopped being free-plan eligible,
  the timer would move to Workers Cron Triggers with a `due_at` column and the precision loss would
  have to be accepted or the project would move host.
