import { Hono } from "hono";
import {
  callIdFromDelivery,
  eventIdFromDelivery,
  verifyCall,
} from "../calle/verify.js";
import { Repo } from "../db/repo.js";
import { alertPayload } from "../domain/incident.js";
import { ConfigurationError, type Bindings, readConfig } from "./env.js";
import { incidentStub } from "./incident-client.js";
import { buildPlacer, waitUntilScheduler } from "./wiring.js";

export { IncidentDurableObject } from "./incident-do.js";

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
  const result = await incidentStub(c.env, alert.service, alert.title).open(
    alert,
  );

  return c.json(
    {
      incident: result.incident.id,
      state: result.incident.state,
      duplicate: result.kind === "duplicate",
    },
    202,
  );
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

  const repo = new Repo(c.env.DB);
  const isNew = await repo.claimEvent(eventId, new Date().toISOString());
  // Deliveries are at least once, so a repeat is expected traffic rather than an error.
  if (!isNew) return c.json({ ok: true, duplicate: true });

  const callId = callIdFromDelivery(body);
  if (callId === null)
    return c.json({ error: "no call id in the delivery" }, 400);

  const placer = buildPlacer(c.env, config, {
    scheduler: waitUntilScheduler(c.executionCtx),
  });
  const snapshot = await verifyCall(placer, callId);

  const incidentId =
    typeof snapshot.metadata["incident_id"] === "string"
      ? snapshot.metadata["incident_id"]
      : null;
  if (incidentId === null)
    return c.json({ ok: true, ignored: "call has no incident" });

  const incident = await repo.getIncident(incidentId);
  if (incident === null)
    return c.json({ ok: true, ignored: "unknown incident" });

  await incidentStub(c.env, incident.service, incident.title).callTerminal(
    snapshot,
  );

  return c.json({ ok: true });
});

app.get("/api/incidents", async (c) => {
  const repo = new Repo(c.env.DB);
  return c.json({ incidents: await repo.listIncidents() });
});

app.get("/api/incidents/:id", async (c) => {
  const repo = new Repo(c.env.DB);
  const incident = await repo.getIncident(c.req.param("id"));
  if (incident === null) return c.json({ error: "no such incident" }, 404);
  return c.json({ incident, events: await repo.listEvents(incident.id) });
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

export default app;
