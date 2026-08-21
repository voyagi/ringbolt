import { Hono } from "hono";
import {
  callIdFromDelivery,
  eventIdFromDelivery,
  verifyCall,
} from "../calle/verify.js";
import { isTerminalCall } from "../calle/port.js";
import { Repo } from "../db/repo.js";
import {
  type Incident,
  alertPayload,
  fingerprintFor,
} from "../domain/incident.js";
import { incidentIdOf } from "../domain/orchestrator.js";
import { ConfigurationError, type Bindings, readConfig } from "./env.js";
import { incidentStub } from "./incident-client.js";
import { reconcile } from "./reconcile.js";
import { buildPlacer, waitUntilScheduler } from "./wiring.js";

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

app.get("/api/budget", async (c) => {
  const repo = new Repo(c.env.DB);
  const spent = await repo.countRealCalls();
  return c.json({
    realCallsPlaced: spent,
    freeTierTotal: 20,
    remaining: Math.max(0, 20 - spent),
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
    ctx: ExecutionContext,
  ): Promise<void> {
    await reconcile(env, {
      scheduler: waitUntilScheduler(ctx),
      now: () => new Date(),
    });
  },
};
