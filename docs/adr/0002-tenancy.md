# ADR 0002: One deployment is one tenant

Status: accepted
Date: 2026-08-25

## Context

Ringbolt holds what is broken in a team's production estate, the telephone numbers of the people who
get woken up about it, the recordings of what they said, and the credentials for changing systems on
their say-so. If two teams ever shared one instance of it, a bug in a WHERE clause would be one team
reading another team's incident, or worse, one team's runbook action reaching another team's
systems.

The roadmap called this phase "authentication and per-tenant isolation". Those are two questions,
and the second one has to be answered first, because what authentication has to prove depends
entirely on what it is separating.

## Decision

**The unit of tenancy is the deployment.** One team, one Worker, one D1 database, one set of
secrets, one administrator token. There is no tenant column anywhere in the schema and there is not
going to be one.

Everything that already exists in this product points the same way, and this is a decision to stop
half-doing something else rather than a new direction:

- The CALL-E key, the numbers a live build may dial and the hosts an action may reach are deployment
  configuration, read from bindings, not rows. A second tenant in the same deployment would share
  all three, which means sharing the ability to telephone the first tenant's rota.
- `DEMO_MODE` is a deployment switch for exactly this reason. A value inside the product that could
  make it public would be a value somebody could flip.
- The public demo is already documented as needing its own database, because it publishes what it
  holds.
- A deployment per team is the affordable shape at the scale this product is for, which is teams too
  small to have a funded rotation. Nothing here is expensive to run twice.

## What that makes authentication

One shared administrator token, `ADMIN_TOKEN`, presented as a bearer token, compared in constant
time, and required by everything that reads operational data or writes configuration. Outside
development those endpoints refuse to serve at all until it is set, which fails closed. Repeated
wrong tokens from one address are answered with a refusal to keep trying.

That is deliberately not a user system, and the honest reason is that a user system would be worse
here rather than better. Accounts mean a password store, a reset flow that runs through email, and
sessions, which is three new things to get wrong protecting the same single boundary, on a product
where the people using it are the two or three who share the pager anyway. The token is what an
operator already handles: a secret in the deployment, rotated by deploying.

What it costs, stated rather than implied:

- No per-person audit of who read the dashboard. The audit trail records who authorized a production
  change on a call, which is the record that matters here, and that comes from the rotation rather
  than from a login.
- Revoking one person means rotating the token and telling the others.
- Nothing distinguishes two people using the same deployment. That is the tenancy decision working
  as intended, not a gap in it.

## What would have to change to make it multi-tenant

Written down so that nobody has to guess at it later, and so the size of it is visible:

1. A tenant column on every table, with every query in `src/db/repo.ts` taking a tenant and a test
   that no statement can be built without one.
2. Per-tenant credentials, which means the CALL-E key and every `RUNBOOK_SECRET_*` binding become
   stored secrets rather than deployment configuration. That is the hard half: it puts other
   people's production credentials in the database.
3. A tenant-scoped host allowlist and number allowlist, which are currently the two things that stop
   an action reaching somewhere it should not.
4. Accounts, sessions, and an invite flow, since a shared token cannot separate tenants.
5. Durable Object naming per tenant, so one tenant's incident cannot collide with another's.

Numbers 2 and 3 are the reason this is a different product rather than a bigger version of this one.

## Consequences

- The isolation guarantee is one a reader can check: there is no cross-tenant query because there is
  no tenant.
- A demo deployment and a real one must not share a database. That was already true and is now the
  general rule rather than a note about the demo.
- The README says which endpoints are open and which are behind the token, so nobody has to read the
  router to find out.
