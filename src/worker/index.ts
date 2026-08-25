import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  callIdFromDelivery,
  eventIdFromDelivery,
  verifyCall,
} from "../calle/verify.js";
import { CALL_PRICE_USD, isTerminalCall, usd } from "../calle/port.js";
import {
  type ActionDefinition,
  type ActionDefinitionInput,
  actionDefinitionInput,
  actionHost,
  actionIdPattern,
} from "../actions/definition.js";
import { Repo, SHARED_ROTATION } from "../db/repo.js";
import { demoHistoryPresent, seedDemoHistory } from "../demo/history.js";
import {
  breakDemoService,
  demoAlert,
  readDemo,
  repairDemoService,
} from "../demo/service.js";
import {
  type Incident,
  alertPayload,
  fingerprintFor,
} from "../domain/incident.js";
import { type OpenResult, incidentIdOf } from "../domain/orchestrator.js";
import {
  type ServicePolicy,
  defaultPolicy,
  servicePolicyInput,
} from "../domain/policy.js";
import {
  type Contact,
  contactInput,
  rotationInput,
} from "../domain/rotation.js";
import {
  ConfigurationError,
  type Bindings,
  type RingboltConfig,
  allowedActionHosts,
  readConfig,
} from "./env.js";
import type { AdminMode, SessionView } from "../domain/view.js";
import {
  readBoard,
  toActionRunView,
  toCallView,
  toEventView,
  toView,
} from "./board.js";
import { incidentStub } from "./incident-client.js";
import {
  ADMIN_FAILURES,
  INTAKE_ALL,
  INTAKE_OVERALL,
  INTAKE_PER_SENDER,
  adminBucket,
  countAgainst,
  intakeBucket,
  senderOf,
} from "./limits.js";
import { reconcile } from "./reconcile.js";
import { enforceRetention } from "./retention.js";
import { buildPlacer, newId, waitUntilScheduler } from "./wiring.js";

export { IncidentDurableObject } from "./incident-do.js";

/**
 * How long a delivery may hold a claim on an event id before another delivery of the same id may
 * take it over. It only matters when a delivery neither completes nor releases, which means the
 * isolate handling it died mid-flight.
 */
const CLAIM_STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * What stands where an erased person's name used to be. It is a sentence rather than a blank
 * because the audit trail has to keep saying that a human authorized the change: an action run with
 * nobody on it reads as one nobody authorized, which is a different claim and a false one.
 */
const ERASED_CONTACT = "a contact erased at their own request";

const app = new Hono<{ Bindings: Bindings }>();

/**
 * The paths a public demo may still be written through. Everything else is refused outright while
 * DEMO_MODE is on, whatever token the caller presents, and that is the whole of what read-only
 * means here: it is a property of the deployment, checked in one place, rather than a set of
 * buttons a screen does not draw.
 *
 * The two that are not demo controls are each here for a reason. Intake is how an alert arrives and
 * it carries its own token, so it was never open to a stranger. The webhook is how a call comes
 * back, and nothing in its body is believed anyway: the call is read back from the provider before
 * any of it is acted on.
 */
const WRITABLE_ON_A_PUBLIC_DEMO = [
  "/api/demo/break",
  "/api/demo/repair",
  "/api/demo/seed",
  "/webhooks/calle",
];

const publicDemoIsReadOnly: MiddlewareHandler<{ Bindings: Bindings }> = async (
  c,
  next,
) => {
  if (isPublicDemo(c.env) && changesSomething(c.req.method, c.req.path)) {
    return c.json(
      {
        error:
          "this deployment is the public demo, so it is read only apart from the demo controls",
      },
      403,
    );
  }
  await next();
  return undefined;
};

app.use("*", publicDemoIsReadOnly);

app.get("/health", (c) => {
  try {
    const config = readConfig(c.env);
    return c.json({
      ok: true,
      environment: config.RINGBOLT_ENV,
      calleMode: config.CALLE_MODE,
    });
  } catch (error) {
    if (error instanceof ConfigurationError)
      return c.json({ ok: false, issues: error.issues }, 500);
    throw error;
  }
});

/**
 * What the dashboard needs before it can ask for anything else: whether this deployment wants an
 * administrator token, and which telephone it is wired to.
 *
 * It is deliberately outside the admin guard. A screen that cannot tell "you need a token" from
 * "the server is broken" shows the same spinner for both, and the operator is left guessing at
 * three in the morning. Nothing here is a secret: it says a token is REQUIRED, never what it is.
 */
app.get("/api/session", (c) => {
  const config = readConfig(c.env);
  const session: SessionView = {
    admin: adminMode(config),
    environment: config.RINGBOLT_ENV,
    calleMode: config.CALLE_MODE,
    retention: {
      transcriptDays: config.RETENTION_TRANSCRIPT_DAYS,
      incidentDays: config.RETENTION_INCIDENT_DAYS,
    },
  };
  return c.json(session);
});

app.post("/intake/:token", async (c) => {
  const config = readConfig(c.env);
  const token = c.req.param("token");

  if (config.INTAKE_TOKEN === undefined) {
    if (config.RINGBOLT_ENV !== "development") {
      return c.json({ error: "intake is not configured" }, 503);
    }
  } else if (!timingSafeEqual(token, config.INTAKE_TOKEN)) {
    return c.json({ error: "unknown intake token" }, 404);
  }

  // Deliberately after the token check rather than before it. The limiter's own bookkeeping is a
  // database write, so counting an anonymous caller who has not named a real token would turn the
  // thing that protects this endpoint into the cheapest way to make it write.
  const flooding = await tooManyAlerts(c);
  if (flooding !== null) return flooding;

  const parsed = alertPayload.safeParse(await readJson(c.req.raw));
  if (!parsed.success) {
    return c.json(
      {
        error: "the alert did not match the expected shape",
        issues: parsed.error.issues.map(describeIssue),
      },
      422,
    );
  }

  const alert = parsed.data;
  return openedAnswer(
    c,
    await incidentStub(c.env, fingerprintFor(alert)).open(alert),
  );
});

/**
 * Whether this alert is one too many, and the refusal to send back if it is.
 *
 * Two allowances rather than one. The per-sender limit catches the monitor that has started
 * looping, which is the ordinary failure; the overall limit is what remains when the same token is
 * used from many addresses, and it matters because every alert that gets through this endpoint can
 * ring a telephone.
 *
 * A refusal here is a 429 with a Retry-After, which is what a monitor knows how to read, and it
 * leaves no incident behind: a sender backing off and trying again gets a fresh judgement rather
 * than being answered as a duplicate of something that was never opened.
 */
async function tooManyAlerts(
  c: Context<{ Bindings: Bindings }>,
): Promise<Response | null> {
  const repo = new Repo(c.env.DB);
  const now = new Date();
  const sender = senderOf(c.req.raw.headers);

  const perSender = await countAgainst(
    repo,
    intakeBucket(sender),
    INTAKE_PER_SENDER,
    now,
  );
  const overall = await countAgainst(repo, INTAKE_ALL, INTAKE_OVERALL, now);
  if (perSender.allowed && overall.allowed) return null;

  const retryAfter = Math.max(
    perSender.allowed ? 0 : perSender.retryAfterSeconds,
    overall.allowed ? 0 : overall.retryAfterSeconds,
  );
  return c.json(
    {
      error:
        "too many alerts too quickly, so this one was not opened. Every alert that gets through here can ring a telephone.",
      retryAfterSeconds: retryAfter,
    },
    429,
    { "retry-after": String(retryAfter) },
  );
}

/**
 * How an accepted alert is answered, whichever door it arrived through: the intake endpoint a
 * monitor posts to, or the demo service's own break control.
 *
 * A telephone that would not dial is reported as such rather than as an accepted alert. The
 * incident is closed as failed, so the sender retrying makes a fresh attempt instead of being
 * answered as a duplicate of the one that never rang.
 */
function openedAnswer(
  c: Context<{ Bindings: Bindings }>,
  result: OpenResult,
): Response {
  const body = {
    incident: result.incident.id,
    state: result.incident.state,
    duplicate: result.kind === "duplicate",
  };
  if (result.kind === "call_failed")
    return c.json({ ...body, error: result.detail }, 502);
  return c.json(body, 202);
}

/**
 * CALL-E delivers this unsigned, so nothing in the body is treated as fact. The delivery is used
 * for two things only: to know which call to go and read, and to deduplicate retries.
 */
app.post("/webhooks/calle", async (c) => {
  const config = readConfig(c.env);
  const body = await readJson(c.req.raw);

  const eventId = eventIdFromDelivery(
    body,
    c.req.header("CALL-E-Event-Id") ?? null,
  );
  if (eventId === null) return c.json({ error: "no usable event id" }, 400);

  const callId = callIdFromDelivery(body);
  if (callId === null)
    return c.json({ error: "no call id in the delivery" }, 400);

  // Nothing is written before this point. The endpoint is unauthenticated by necessity, so a
  // caller who has not named a call that genuinely exists must not be able to leave a row behind,
  // and above all must not be able to spend an event id that a real delivery still needs.
  const placer = buildPlacer(c.env, config, {
    scheduler: waitUntilScheduler(c.executionCtx),
  });
  const snapshot = await verifyCall(placer, callId);

  // A call that is still running carries no decision, and the caller who named it is anonymous.
  // Answering one as though it were terminal would spend the incident's only move out of `calling`
  // and throw away the decision the responder is at that moment giving. Nothing is claimed for it.
  if (!isTerminalCall(snapshot.status))
    return c.json({ ok: true, ignored: "the call is still running" });

  const incidentId = incidentIdOf(snapshot);
  if (incidentId === null)
    return c.json({ ok: true, ignored: "call has no incident" });

  const repo = new Repo(c.env.DB);
  const incident = await repo.getIncident(incidentId);
  if (incident === null)
    return c.json({ ok: true, ignored: "unknown incident" });

  const startedAt = new Date();
  const claimId = crypto.randomUUID();
  const claimed = await repo.claimEvent(
    eventId,
    claimId,
    startedAt.toISOString(),
    new Date(startedAt.getTime() - CLAIM_STALE_AFTER_MS).toISOString(),
  );
  // Deliveries are at least once, so a repeat is expected traffic rather than an error.
  if (!claimed) return c.json({ ok: true, duplicate: true });

  try {
    await incidentStub(c.env, incident.fingerprint).callTerminal(snapshot);
  } catch (error) {
    // The claim is the thing that makes a retry a no-op, so a delivery that did not finish its
    // work has to give it back. The provider retrying is the only recovery this design has, and
    // holding the id while answering a non-200 disarms it.
    await repo.releaseEvent(eventId, claimId);
    throw error;
  }

  await repo.completeEvent(eventId, claimId, new Date().toISOString());
  return c.json({ ok: true });
});

/**
 * Everything that decides which telephone rings sits behind this, and so is everything that says
 * anything about somebody's production estate. An unguarded write here is a stranger's phone going
 * off at three in the morning, charged to the owner, and an unguarded read is a list of what is
 * broken in their systems and who is being telephoned about it.
 *
 * The subtree is guarded in one place rather than route by route on purpose. A guard repeated at
 * nine handlers is a guard that will eventually be missing from the tenth.
 */
const adminOnly: MiddlewareHandler<{ Bindings: Bindings }> = async (
  c,
  next,
) => {
  const config = readConfig(c.env);
  const refusal = await adminRefusal(c, config);
  if (refusal !== null) return refusal;
  await next();
  return undefined;
};

app.use("/api/config/*", adminOnly);

// The audit trail carries the call transcript, which is personal data and is also the evidence
// behind a production change. Neither belongs on the open read API.
app.use("/api/audit/*", adminOnly);

// These two were open until 2026-08-25, from the walking skeleton, when the whole product was a
// curl and a page. What they publish is what is broken in somebody's estate right now, which
// service, how bad, and how far Ringbolt has got with it, and that is not a public fact about
// anybody's business. Development with no token set is still open, so the curls in the README go on
// working on a laptop; every other environment now needs the token.
//
// The wildcard covers the bare path as well as everything under it, which is deliberate and is
// asserted rather than assumed: the same thing was already true of `/api/demo` and it cost a
// failing test to find out.
app.use("/api/incidents/*", adminOnly);
app.use("/api/services/*", adminOnly);

app.get("/api/incidents", async (c) => {
  const repo = new Repo(c.env.DB);
  const incidents = await repo.listIncidents();
  return c.json({ incidents: incidents.map(forPublicList) });
});

app.get("/api/incidents/:id", async (c) => {
  const repo = new Repo(c.env.DB);
  const incident = await repo.getIncident(c.req.param("id"));
  if (incident === null) return c.json({ error: "no such incident" }, 404);
  return c.json({
    incident: withoutCallId(incident),
    events: await repo.listEvents(incident.id),
  });
});

app.get("/api/services/:service/state", async (c) => {
  const repo = new Repo(c.env.DB);
  const state = await repo.getServiceState(c.req.param("service"));
  if (state === null)
    return c.json({ error: "no state recorded for that service" }, 404);
  return c.json({ state });
});

// The demo controls change a service's state and place a call, so on any deployment that is not the
// public demo they are guarded exactly like the configuration is. On the public demo the guard
// itself stands down, which is the one thing that deployment exists to allow.
//
// The wildcard covers the bare `/api/demo` as well as the controls under it, which is deliberate
// and was also measured rather than assumed: `test/demo.test.ts` asserts both halves. The read is
// no more public than the board it sits beside.
app.use("/api/demo/*", adminOnly);

/**
 * What the demo service says about itself: which release it is running, whether it has been
 * switched off, what it is therefore serving, and which of its controls may be pressed right now.
 */
app.get("/api/demo", async (c) => {
  const repo = new Repo(c.env.DB);
  return c.json(
    await readDemo(repo, new Date(), {
      publicDemo: readConfig(c.env).DEMO_MODE,
      seeded: await demoHistoryPresent(repo),
    }),
  );
});

/**
 * Puts the bad release out and tells Ringbolt about it, through the same orchestrator every other
 * alert goes through. The refusal is the same function the screen's own controls are drawn from, so
 * a button that looks pressable and a request that is refused cannot disagree.
 */
app.post("/api/demo/break", async (c) => {
  const broken = await breakDemoService(new Repo(c.env.DB), new Date());
  if (!broken.ok) return c.json({ error: broken.why }, 409);

  const alert = demoAlert(broken.state);
  return openedAnswer(
    c,
    await incidentStub(c.env, fingerprintFor(alert)).open(alert),
  );
});

/** Puts the demo service back by hand, which is the operator acting rather than Ringbolt. */
app.post("/api/demo/repair", async (c) => {
  const repaired = await repairDemoService(new Repo(c.env.DB), new Date());
  if (!repaired.ok) return c.json({ error: repaired.why }, 409);
  return c.json({ state: repaired.state });
});

/**
 * The example estate, written once. A second call finds it already there and writes nothing.
 *
 * It is refused on a real deployment, and that is not tidiness. The estate carries two fictional
 * contacts and puts them in the shared rota when there is no rota yet, so seeding an install that
 * somebody is actually on call for would quietly make Ringbolt telephone a number that cannot be
 * reached. A demo and a laptop are the two places where that is what you asked for.
 */
app.post("/api/demo/seed", async (c) => {
  const config = readConfig(c.env);
  if (!config.DEMO_MODE && config.RINGBOLT_ENV !== "development") {
    return c.json(
      {
        error:
          "the example history writes contacts and a calling order, so it is refused outside development unless DEMO_MODE is on",
      },
      409,
    );
  }

  const result = await seedDemoHistory(new Repo(c.env.DB), new Date());
  return c.json(result, result.seeded ? 201 : 200);
});

app.get("/api/config/actions", async (c) => {
  const repo = new Repo(c.env.DB);
  return c.json({
    actions: await repo.listActionDefinitions(),
    allowedHosts: allowedActionHosts(readConfig(c.env)),
  });
});

app.get("/api/config/actions/:id", async (c) => {
  const action = await new Repo(c.env.DB).getActionDefinition(
    c.req.param("id"),
  );
  if (action === null) return c.json({ error: "no such action" }, 404);
  return c.json({ action });
});

/**
 * Writing an action is writing what Ringbolt may do to a production system on somebody's spoken
 * say-so, so everything that can be refused here is refused here, at a keyboard, rather than at
 * three in the morning: the shape, the target's own rules, and the hosts this deployment may call.
 */
app.put("/api/config/actions/:id", async (c) => {
  const id = c.req.param("id");
  if (!actionIdPattern.test(id)) {
    return c.json(
      {
        error:
          "an action id is lower case letters, digits and underscores, three to forty characters",
      },
      422,
    );
  }

  const parsed = actionDefinitionInput.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return unprocessable(c, parsed.error.issues);

  const allowed = allowedActionHosts(readConfig(c.env));
  const outside = hostsOutside(parsed.data, allowed);
  if (outside.length > 0) {
    return c.json(
      {
        error: `this deployment may not call ${outside.join(", ")}. Names it may call go in ACTION_HOST_ALLOWLIST.`,
        allowedHosts: allowed,
      },
      422,
    );
  }

  const repo = new Repo(c.env.DB);
  const existing = await repo.getActionDefinition(id);
  const at = new Date().toISOString();
  const action: ActionDefinition = {
    ...parsed.data,
    id,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  await repo.upsertActionDefinition(action);
  return c.json({ action }, existing === null ? 201 : 200);
});

app.delete("/api/config/actions/:id", async (c) => {
  const repo = new Repo(c.env.DB);
  const id = c.req.param("id");
  if ((await repo.getActionDefinition(id)) === null)
    return c.json({ error: "no such action" }, 404);

  // Removing an action a policy still permits would quietly shorten what that service can be
  // offered on a call, which is discovered by a responder being told there is nothing to do.
  const services = await repo.policiesPermitting(id);
  if (services.length > 0) {
    return c.json(
      {
        error: `${id} is still permitted for ${services.join(", ")}, so take it out of those policies first`,
        services,
      },
      409,
    );
  }

  await repo.deleteActionDefinition(id);
  return c.json({ ok: true });
});

app.get("/api/config/services", async (c) => {
  const repo = new Repo(c.env.DB);
  return c.json({ services: await repo.listServicePolicies() });
});

app.get("/api/config/services/:service", async (c) => {
  const service = c.req.param("service");
  const repo = new Repo(c.env.DB);
  const stored = await repo.getServicePolicy(service);
  return c.json({
    policy: stored ?? (await defaultFor(repo, service)),
    configured: stored !== null,
  });
});

app.put("/api/config/services/:service", async (c) => {
  const parsed = servicePolicyInput.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return unprocessable(c, parsed.error.issues);

  const defined = (await new Repo(c.env.DB).listActionDefinitions()).map(
    (definition) => definition.id,
  );
  const known = new Set(defined);
  const unknown = parsed.data.allowedActions.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return c.json(
      {
        error: `this install has no such action: ${unknown.join(", ")}`,
        actions: defined,
      },
      422,
    );
  }

  const policy: ServicePolicy = {
    service: c.req.param("service"),
    ...parsed.data,
    updatedAt: new Date().toISOString(),
  };
  await new Repo(c.env.DB).upsertServicePolicy(policy);
  return c.json({ policy });
});

app.get("/api/config/contacts", async (c) => {
  const repo = new Repo(c.env.DB);
  return c.json({
    contacts: readable(await repo.listContacts(), readConfig(c.env)),
  });
});

app.post("/api/config/contacts", async (c) => {
  const parsed = contactInput.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return unprocessable(c, parsed.error.issues);

  const contact = {
    id: newId("con"),
    ...parsed.data,
    createdAt: new Date().toISOString(),
  };
  await new Repo(c.env.DB).createContact(contact);
  return c.json({ contact }, 201);
});

app.delete("/api/config/contacts/:id", async (c) => {
  const repo = new Repo(c.env.DB);
  const id = c.req.param("id");
  if ((await repo.getContact(id)) === null)
    return c.json({ error: "no such contact" }, 404);

  // Deleting somebody who is still in a rota would shorten it silently, and a rotation that is one
  // person shorter than the operator believes is discovered at three in the morning.
  const rotas = await repo.rotationsNaming(id);
  if (rotas.length > 0) {
    return c.json(
      {
        error: `this contact is still in the rotation for ${rotas.join(", ")}, so take them out of it first`,
        services: rotas,
      },
      409,
    );
  }

  await repo.deleteContact(id);
  return c.json({ ok: true });
});

/**
 * The right to be forgotten, carried out rather than promised.
 *
 * It is a separate endpoint from DELETE rather than a flag on it, because they answer different
 * questions. Deleting a contact is "this person is no longer on call": it leaves the audit trail
 * exactly as it was, which is what an operator changing a rota wants. Erasing is "take this person
 * out of the record", which rewrites history and cannot be undone, and something that irreversible
 * should not be reachable by adding a query parameter to a routine request.
 *
 * The rota guard is the same one delete has and it is kept here on purpose. Erasing somebody who is
 * still on call would silently shorten the rotation, which is discovered at three in the morning,
 * so the operator takes them off it first and decides who covers the shift. It is one extra request
 * against nobody being called.
 */
app.post("/api/config/contacts/:id/erase", async (c) => {
  const repo = new Repo(c.env.DB);
  const contact = await repo.getContact(c.req.param("id"));
  if (contact === null) return c.json({ error: "no such contact" }, 404);

  const rotas = await repo.rotationsNaming(contact.id);
  if (rotas.length > 0) {
    return c.json(
      {
        error: `this contact is still in the rotation for ${rotas.join(", ")}, so take them out of it first. Erasing somebody who is still on call would shorten the rotation without saying so.`,
        services: rotas,
      },
      409,
    );
  }

  const erased = await repo.eraseContact(
    contact,
    ERASED_CONTACT,
    new Date().toISOString(),
  );
  return c.json({ erased });
});

app.get("/api/config/rotation/:service", async (c) => {
  const repo = new Repo(c.env.DB);
  const service = c.req.param("service");
  const contacts = await repo.rotationFor(service);
  return c.json({
    service,
    contacts: readable(contacts, readConfig(c.env)),
    own: await repo.hasOwnRotation(service),
    sharedRotation: SHARED_ROTATION,
    // With nobody in the rota, the number in the configuration is who gets called. Saying so is
    // what stops an empty list reading as "this service calls nobody".
    usesConfiguredNumber: contacts.length === 0,
  });
});

app.put("/api/config/rotation/:service", async (c) => {
  const parsed = rotationInput.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return unprocessable(c, parsed.error.issues);

  const ids = parsed.data.contactIds;
  if (new Set(ids).size !== ids.length) {
    return c.json(
      {
        error:
          "the same contact appears twice, so escalating would call them again instead of somebody else",
      },
      422,
    );
  }

  const repo = new Repo(c.env.DB);
  const known = new Set((await repo.listContacts()).map((one) => one.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0)
    return c.json({ error: `no such contact: ${unknown.join(", ")}` }, 422);

  const service = c.req.param("service");
  await repo.setRotation(service, ids);
  return c.json({
    service,
    contacts: readable(await repo.rotationFor(service), readConfig(c.env)),
  });
});

/**
 * Every incident, current and closed, as the history screen reads it. It is separate from the open
 * `/api/incidents` rather than a widening of it: this one names the person who was called, and a
 * responder's name is not something an unauthenticated read gets to publish.
 */
app.get("/api/audit/incidents", async (c) => {
  const repo = new Repo(c.env.DB);
  const names = new Map(
    (await repo.listContacts()).map((one) => [one.id, one.name]),
  );
  const incidents = await repo.listIncidents(200);
  return c.json({
    incidents: incidents.map((incident) => toView(incident, names)),
  });
});

/**
 * The deck, in one read. It sits behind the admin guard because it carries the live call's
 * transcript, which is personal data and is also the evidence behind a production change.
 */
app.get("/api/audit/board", async (c) => {
  const config = readConfig(c.env);
  const board = await readBoard(
    new Repo(c.env.DB),
    new Date(),
    config.CALLE_CREDIT_USD,
  );
  return c.json(board);
});

/**
 * One incident with everything that was decided about it: the timeline, what was said on each
 * call, and every action that ran with the system state either side of it.
 */
app.get("/api/audit/incidents/:id", async (c) => {
  const repo = new Repo(c.env.DB);
  const incident = await repo.getIncident(c.req.param("id"));
  if (incident === null) return c.json({ error: "no such incident" }, 404);

  const names = new Map(
    (await repo.listContacts()).map((one) => [one.id, one.name]),
  );
  const calls = await repo.listCallRecords(incident.id);

  return c.json({
    incident: toView(incident, names),
    events: (await repo.listEvents(incident.id)).map(toEventView),
    calls: calls.map(toCallView),
    actions: (await repo.listActionRuns(incident.id)).map(toActionRunView),
  });
});

/**
 * What has been spent on real calls, in the unit the provider actually bills in. It reported a
 * count against a hardcoded allowance of twenty until 2026-08-24, which was a figure nobody had
 * chosen measuring a thing nobody is charged for.
 */
app.get("/api/budget", async (c) => {
  const config = readConfig(c.env);
  const placed = await new Repo(c.env.DB).countRealCalls();
  const spentUsd = usd(placed * CALL_PRICE_USD);
  const remainingUsd = usd(Math.max(0, config.CALLE_CREDIT_USD - spentUsd));

  return c.json({
    realCallsPlaced: placed,
    callPriceUsd: CALL_PRICE_USD,
    spentUsd,
    creditUsd: config.CALLE_CREDIT_USD,
    remainingUsd,
    callsRemaining: Math.floor(remainingUsd / CALL_PRICE_USD),
  });
});

app.onError((error, c) => {
  if (error instanceof ConfigurationError)
    return c.json({ error: error.message, issues: error.issues }, 500);
  console.error(error);
  return c.json({ error: "something went wrong handling that request" }, 500);
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function describeIssue(issue: {
  path: PropertyKey[];
  message: string;
}): string {
  return `${issue.path.join(".") || "root"}: ${issue.message}`;
}

async function defaultFor(repo: Repo, service: string) {
  const defined = await repo.listActionDefinitions();
  return defaultPolicy(
    service,
    defined.map((definition) => definition.id),
    new Date().toISOString(),
  );
}

/** The hosts a definition would reach that this deployment has not been told it may reach. */
function hostsOutside(
  definition: ActionDefinitionInput,
  allowed: readonly string[] | null,
): string[] {
  if (allowed === null) return [];

  const templates = [
    definition.target.kind === "http" ? definition.target.url : null,
    definition.verify?.url ?? null,
  ];
  const hosts = templates
    .map((template) => (template === null ? null : actionHost(template)))
    .filter((host): host is string => host !== null);
  return [...new Set(hosts.filter((host) => !allowed.includes(host)))];
}

function unprocessable(
  c: Context<{ Bindings: Bindings }>,
  issues: { path: PropertyKey[]; message: string }[],
): Response {
  return c.json(
    {
      error: "that did not match the expected shape",
      issues: issues.map(describeIssue),
    },
    422,
  );
}

/**
 * Whether this deployment lets a caller through, wants a token, or refuses these routes outright.
 *
 * Development with no token set is a laptop talking to itself; every other environment refuses to
 * serve them at all until a token exists, which fails closed rather than shipping an open door
 * nobody notices. The guard below and `/api/session` both read it, so the answer the dashboard is
 * given and the answer it then meets cannot disagree.
 */
function adminMode(config: RingboltConfig): AdminMode {
  if (config.DEMO_MODE) return "demo";
  if (config.ADMIN_TOKEN !== undefined) return "token";
  return config.RINGBOLT_ENV === "development" ? "open" : "unavailable";
}

/**
 * Null when the caller may go on, and the refusal to send back when they may not.
 *
 * A correct token costs nothing beyond the comparison: the rate limit is counted only when the
 * token is wrong, so the dashboard polling every two seconds never touches it. That is also why the
 * limit is on failures rather than on requests. It is not what makes the token safe, a secret of
 * this length compared in constant time is not going to be guessed, but it stops a spray from being
 * free and silent.
 */
async function adminRefusal(
  c: Context<{ Bindings: Bindings }>,
  config: RingboltConfig,
): Promise<Response | null> {
  // A public demo has already refused every write except its own controls, and it cannot be in live
  // mode at all, so a token here would be guarding nothing that is still reachable. What it would do
  // is make the demo unreadable, which is the one thing that deployment exists for.
  if (config.DEMO_MODE) return null;

  const expected = config.ADMIN_TOKEN;
  if (expected === undefined) {
    if (adminMode(config) === "open") return null;
    return c.json(
      {
        error:
          "changing configuration needs ADMIN_TOKEN to be set on this deployment",
      },
      503,
    );
  }

  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (timingSafeEqual(presented, expected)) return null;

  const attempts = await countAgainst(
    new Repo(c.env.DB),
    adminBucket(senderOf(c.req.raw.headers)),
    ADMIN_FAILURES,
    new Date(),
  );
  if (attempts.allowed) return c.json({ error: "not authorized" }, 401);

  return c.json(
    {
      error: "too many attempts with a token this deployment does not accept",
      retryAfterSeconds: attempts.retryAfterSeconds,
    },
    429,
    { "retry-after": String(attempts.retryAfterSeconds) },
  );
}

/**
 * The call id never leaves the service. Authentication on the read API is phase 7, and until then
 * publishing it would hand any caller the one value the unauthenticated webhook route accepts from
 * an anonymous body. The dashboard does not need it, and the audit trail keeps it either way.
 */
function withoutCallId(incident: Incident): Omit<Incident, "callId"> {
  const { callId: _withheld, ...rest } = incident;
  return rest;
}

/**
 * Contacts as a reader is allowed to see them. A public demo publishes everything it holds, so the
 * telephone numbers come out of it: a number is personal data and nobody consented to a stranger
 * reading theirs.
 *
 * Names stay. They are who authorized a production change, which is the whole point of the record,
 * and a demo with the authority column blanked would be a demo of a different product. The honest
 * consequence is that a demo deployment must not share a database with a real one, and
 * `docs/deploying.md` says so in those words.
 */
function readable(contacts: Contact[], config: RingboltConfig): Contact[] {
  if (!config.DEMO_MODE) return contacts;
  return contacts.map((contact) => ({
    ...contact,
    phone: "withheld on a public demo",
  }));
}

/** The list view is a board, so it carries what a board shows and nothing else. */
function forPublicList(incident: Incident) {
  const { detail: _withheld, ...rest } = withoutCallId(incident);
  return rest;
}

/**
 * Whether this deployment is the public demo.
 *
 * A configuration nothing can parse reads as "not the demo", which sounds like a hole and is not
 * one: every route reads the same configuration and answers 500 on it, so there is no write left
 * for this to refuse. Doing it this way keeps the health check's own answer about what is wrong,
 * which is the one page an operator has when the configuration is the problem.
 */
function isPublicDemo(env: Bindings): boolean {
  try {
    return readConfig(env).DEMO_MODE;
  } catch {
    return false;
  }
}

function changesSomething(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (WRITABLE_ON_A_PUBLIC_DEMO.includes(path)) return false;
  return !path.startsWith("/intake/");
}

/**
 * Compares in time proportional to the longer input rather than to the matching prefix, so a
 * caller cannot learn the token one character at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export default {
  fetch: app.fetch,
  /**
   * The reconciliation sweep. A webhook is the happy path, not a guarantee, so this is what makes
   * a lost delivery recoverable rather than final.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const now = new Date();
    await reconcile(env, { now: () => now });

    // Retention runs on the same trigger and after it, because it deletes closed incidents and the
    // sweep above is what closes them. Its own failures are caught inside it: a retention window
    // that stopped working would otherwise take the incident backstop down with it, and an incident
    // that never gets swept is a service whose alerts have quietly stopped ringing.
    const config = readConfig(env);
    await enforceRetention(
      new Repo(env.DB),
      {
        transcriptDays: config.RETENTION_TRANSCRIPT_DAYS,
        incidentDays: config.RETENTION_INCIDENT_DAYS,
      },
      now,
    );
  },
};
