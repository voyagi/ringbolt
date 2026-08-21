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

Durable Objects give property 3 outright and property 4 conditionally. One Durable Object per
incident is a single-threaded actor that owns that incident's state machine. Its `alarm` API is a
durable timer that fires at a specific time, survives restarts, and needs no sweeper. It can hold
the dashboard's WebSocket connections and push state as the call progresses.

**Correction, 2026-08-21, recorded in place rather than edited away, because the original claim is
what the stack choice was argued on.** This paragraph first said that concurrent webhooks
"serialize against one owner instead of racing rows", full stop. That overstates the guarantee and
a review caught it. Cloudflare's documented behaviour is narrower: the input gate defers incoming
events while one of the object's **own storage** operations is in flight, and awaiting anything
else opens the gate so new events interleave. Their guidance is explicit that once you await,
other events can interleave, and that `blockConcurrencyWhile()` is the tool for a critical section
that awaits an external call.

Ringbolt's object awaits D1 and the call provider, never `ctx.storage`, so it got no automatic
serialization at all. The single-owner property is still available and is still the reason to be
here, but it has to be taken deliberately.

**Taken, 2026-08-21.** The object supplies the orchestrator with an `exclusive` function backed by
`ctx.blockConcurrencyWhile()`, and the read-then-write sections run inside it: the check for an
already-open incident before creating one, and the move out of `calling` before an action is
authorized. Only database work is held there. Placing the call and running the action are outside
it, because a blocked section is capped at thirty seconds and a telephone call is not a thing to
hold a lock across. The callback catches its own failures and returns them as a value, because a
throw out of `blockConcurrencyWhile()` terminates and resets the object.

A second layer sits underneath, in case anything ever reaches the database without an owner: a
unique index on `fingerprint` filtered to the open states, so a second open incident for one
fingerprint fails loudly instead of becoming a second phone call. The collision is answered as the
duplicate it is.

The window is reproduced in `test/concurrency.test.ts` rather than argued about. Two concurrent
terminal deliveries with no section held do run the action twice, and the same pair with the
section held run it once. The local workers pool delivers messages to one Durable Object in series
of its own accord, so the equivalent test through the object is a regression guard rather than a
reproduction, and the measurement is taken at the seam where the section is applied.

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

- One storage system today, not two. D1 holds every record, and the Durable Object holds no state
  of its own: what it provides is a single owner per incident and the section that makes a
  read-then-write safe. The consequence originally written here, that the object would be the
  source of truth while an incident is live, is not what was built, and saying so was what let the
  serialization claim above go unexamined for as long as it did.
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
