import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  callIdFromDelivery,
  eventIdFromDelivery,
  verifyCall,
} from "../calle/verify.js";
import { REAL_CALL_ALLOWANCE, isTerminalCall } from "../calle/port.js";
import {
  type ActionDefinition,
  type ActionDefinitionInput,
  actionDefinitionInput,
  actionHost,
  actionIdPattern,
} from "../actions/definition.js";
import { Repo, SHARED_ROTATION } from "../db/repo.js";
import {
  type Incident,
  alertPayload,
  fingerprintFor,
} from "../domain/incident.js";
import { incidentIdOf } from "../domain/orchestrator.js";
import {
  type ServicePolicy,
  defaultPolicy,
  servicePolicyInput,
} from "../domain/policy.js";
import { contactInput, rotationInput } from "../domain/rotation.js";
import {
  ConfigurationError,
  type Bindings,
  type RingboltConfig,
  allowedActionHosts,
  readConfig,
} from "./env.js";
import { incidentStub } from "./incident-client.js";
import { reconcile } from "./reconcile.js";
import { buildPlacer, newId, waitUntilScheduler } from "./wiring.js";

export { IncidentDurableObject } from "./incident-do.js";

/**
 * How long a delivery may hold a claim on an event id before another delivery of the same id may
 * take it over. It only matters when a delivery neither completes nor releases, which means the
 * isolate handling it died mid-flight.
 */
const CLAIM_STALE_AFTER_MS = 2 * 60 * 1000;

const app = new Hono<{ Bindings: Bindings }>();

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
  const result = await incidentStub(c.env, fingerprintFor(alert)).open(alert);
  const body = {
    incident: result.incident.id,
    state: result.incident.state,
    duplicate: result.kind === "duplicate",
  };

  // A telephone that would not dial is reported as such rather than as an accepted alert. The
  // incident is closed as failed, so the sender retrying makes a fresh attempt instead of being
  // answered as a duplicate of the one that never rang.
  if (result.kind === "call_failed")
    return c.json({ ...body, error: result.detail }, 502);

  return c.json(body, 202);
});

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

/**
 * Everything that decides which telephone rings sits behind this. It is not authentication, which
 * is phase 7: it is the floor until then, because an unguarded write here is a stranger's phone
 * going off at three in the morning, charged against an allowance of twenty calls.
 *
 * The subtree is guarded in one place rather than route by route on purpose. A guard repeated at
 * nine handlers is a guard that will eventually be missing from the tenth.
 */
const adminOnly: MiddlewareHandler<{ Bindings: Bindings }> = async (
  c,
  next,
) => {
  const config = readConfig(c.env);
  const refusal = adminRefusal(c, config);
  if (refusal !== null) return refusal;
  await next();
  return undefined;
};

app.use("/api/config/*", adminOnly);

// The audit trail carries the call transcript, which is personal data and is also the evidence
// behind a production change. Neither belongs on the open read API.
app.use("/api/audit/*", adminOnly);

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
  return c.json({ contacts: await repo.listContacts() });
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

app.get("/api/config/rotation/:service", async (c) => {
  const repo = new Repo(c.env.DB);
  const service = c.req.param("service");
  const contacts = await repo.rotationFor(service);
  return c.json({
    service,
    contacts,
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
  return c.json({ service, contacts: await repo.rotationFor(service) });
});

/**
 * One incident with everything that was decided about it: the timeline, what was said on each
 * call, and every action that ran with the system state either side of it.
 */
app.get("/api/audit/incidents/:id", async (c) => {
  const repo = new Repo(c.env.DB);
  const incident = await repo.getIncident(c.req.param("id"));
  if (incident === null) return c.json({ error: "no such incident" }, 404);

  return c.json({
    incident,
    events: await repo.listEvents(incident.id),
    calls: await repo.listCallRecords(incident.id),
    actions: await repo.listActionRuns(incident.id),
  });
});

app.get("/api/budget", async (c) => {
  const repo = new Repo(c.env.DB);
  const spent = await repo.countRealCalls();
  return c.json({
    realCallsPlaced: spent,
    freeTierTotal: REAL_CALL_ALLOWANCE,
    remaining: Math.max(0, REAL_CALL_ALLOWANCE - spent),
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
 * Null when the caller may change configuration, and the refusal to send back when they may not.
 * Development with no token set is allowed through because that is a laptop talking to itself;
 * every other environment refuses to serve these routes at all until a token exists, which fails
 * closed rather than shipping an open door nobody notices.
 */
function adminRefusal(
  c: Context<{ Bindings: Bindings }>,
  config: RingboltConfig,
): Response | null {
  if (config.ADMIN_TOKEN === undefined) {
    if (config.RINGBOLT_ENV === "development") return null;
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
  if (!timingSafeEqual(presented, config.ADMIN_TOKEN))
    return c.json({ error: "not authorized" }, 401);
  return null;
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

/** The list view is a board, so it carries what a board shows and nothing else. */
function forPublicList(incident: Incident) {
  const { detail: _withheld, ...rest } = withoutCallId(incident);
  return rest;
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
    await reconcile(env, { now: () => new Date() });
  },
};
