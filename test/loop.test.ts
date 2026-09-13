import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CallSnapshot } from "../src/calle/port.js";
import { Repo } from "../src/db/repo.js";
import { resetTables } from "./support/reset.js";
import { deliverWebhook, terminalCallFor } from "./support/webhook.js";

const TOKEN = "test-dummy-intake-token-0123456789";

async function postAlert(body: unknown, token = TOKEN): Promise<Response> {
  return SELF.fetch(`https://ringbolt.test/intake/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A call that has been placed and has not finished, put where the stand-in keeps its calls so that
 * reading it back is deterministic rather than a race against the stand-in's own think time.
 */
async function aCallStillRinging(incidentId: string): Promise<CallSnapshot> {
  const queued: CallSnapshot = {
    id: `call_still_ringing_${incidentId}`,
    status: "queued",
    taskCompleted: null,
    confidenceScore: null,
    confidenceLabel: null,
    structuredResult: null,
    summary: null,
    evidence: [],
    transcript: [],
    metadata: { incident_id: incidentId },
    failureCode: null,
  };

  await env.DB.prepare(
    `INSERT INTO fake_calls (id, idempotency_key, snapshot, updated_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(
      queued.id,
      `${incidentId}:still-ringing`,
      JSON.stringify(queued),
      new Date().toISOString(),
    )
    .run();

  return queued;
}

describe("the whole loop", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  it("takes an alert all the way to a changed system", async () => {
    const response = await postAlert({
      service: "checkout",
      title: "Payment errors above 20 percent",
      severity: "critical",
      detail:
        "Error rate went from 0.2 percent to 23 percent after the 14:02 deploy.",
      source: "uptime-probe",
    });

    expect(response.status).toBe(202);
    const accepted = (await response.json()) as {
      incident: string;
      state: string;
      duplicate: boolean;
    };
    expect(accepted.state).toBe("calling");
    expect(accepted.duplicate).toBe(false);

    const call = await terminalCallFor(env.DB, accepted.incident);
    expect(call.status).toBe("completed");

    const delivered = await deliverWebhook(call);
    expect(delivered.status).toBe(200);

    const repo = new Repo(env.DB);
    const incident = await repo.getIncident(accepted.incident);
    expect(incident?.state).toBe("resolved");
    expect(incident?.outcome).toBe("kill_switch:succeeded");

    const state = await repo.getServiceState("checkout");
    expect(state?.killSwitch).toBe(true);

    const events = await repo.listEvents(accepted.incident);
    expect(events.map((event) => event.kind)).toEqual([
      "alert.received",
      "call.placed",
      "call.ended",
      "action.succeeded",
    ]);
  });

  it("ignores a replayed delivery of the same event", async () => {
    const response = await postAlert({
      service: "search",
      title: "Latency above 5 seconds",
    });
    const accepted = (await response.json()) as { incident: string };
    const call = await terminalCallFor(env.DB, accepted.incident);

    const eventId = "evt_replayed_once";
    expect((await deliverWebhook(call, eventId)).status).toBe(200);

    const second = await deliverWebhook(call, eventId);
    expect(await second.json()).toMatchObject({ duplicate: true });

    const runs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_runs`,
    ).first<{ n: number }>();
    expect(runs?.n).toBe(1);
  });

  it("refuses a delivery that names a call the API does not have", async () => {
    const forged = await SELF.fetch("https://ringbolt.test/webhooks/calle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CALL-E-Event-Id": "evt_forged",
      },
      body: JSON.stringify({
        id: "evt_forged",
        type: "call.completed",
        created_at: new Date().toISOString(),
        data: {
          id: "call_that_never_existed",
          status: "completed",
          metadata: { incident_id: "inc_whatever" },
        },
      }),
    });

    expect(forged.status).toBe(500);
    const runs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_runs`,
    ).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  /**
   * The failure that ran end to end before this branch. One timeout reading the call back used to
   * be enough: the event id was spent on the way in, so the provider's retry of the same id, which
   * is the only recovery this design has, was answered "duplicate" and did nothing. The responder's
   * decision was gone and the incident sat in `calling` for ever, which then made every later
   * repeat of that alert a duplicate of a call that never finished.
   */
  it("does not spend the event id on a delivery it could not process", async () => {
    const response = await postAlert({
      service: "checkout",
      title: "Payment errors above 20 percent",
    });
    const accepted = (await response.json()) as { incident: string };
    const call = await terminalCallFor(env.DB, accepted.incident);

    const eventId = "evt_retried_after_a_failure";
    const lost = await SELF.fetch("https://ringbolt.test/webhooks/calle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CALL-E-Event-Id": eventId,
      },
      body: JSON.stringify({
        id: eventId,
        type: "call.completed",
        created_at: new Date().toISOString(),
        data: { id: "call_the_api_cannot_read", status: "completed" },
      }),
    });
    expect(lost.status).toBe(500);

    const retry = await deliverWebhook(call, eventId);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true });

    const repo = new Repo(env.DB);
    expect((await repo.getIncident(accepted.incident))?.state).toBe("resolved");
  });

  /**
   * A call that is still running carries no decision. Answering one as though it were terminal
   * spends the incident's only move out of `calling`, and the decision the responder is at that
   * moment giving is then dropped in silence when it arrives. Two ordinary HTTP requests from
   * anywhere would have disarmed the on-call system for that incident and, because the incident
   * stays open, silenced every later repeat of that alert.
   */
  it("ignores a delivery about a call that is still running", async () => {
    const response = await postAlert({
      service: "checkout",
      title: "Payment errors above 20 percent",
    });
    const accepted = (await response.json()) as { incident: string };

    // A second call for the same incident, written straight into the stand-in's store and left
    // ringing. Reading the real one back would be a race against its own think time, and a test
    // that sometimes reads a finished call is a test that sometimes proves nothing.
    const queued = await aCallStillRinging(accepted.incident);

    const early = await SELF.fetch("https://ringbolt.test/webhooks/calle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CALL-E-Event-Id": "evt_too_early",
      },
      body: JSON.stringify({
        id: "evt_too_early",
        type: "call.completed",
        created_at: new Date().toISOString(),
        data: { id: queued.id },
      }),
    });

    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({
      ignored: "the call is still running",
    });

    const claims = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM processed_events`,
    ).first<{ n: number }>();
    expect(claims?.n).toBe(0);

    const repo = new Repo(env.DB);
    expect((await repo.getIncident(accepted.incident))?.state).toBe("calling");

    const call = await terminalCallFor(env.DB, accepted.incident);
    expect((await deliverWebhook(call)).status).toBe(200);
    expect((await repo.getIncident(accepted.incident))?.state).toBe("resolved");
  });

  it("does not publish the call id on the unauthenticated read api", async () => {
    await postAlert({ service: "checkout", title: "down" });

    const list = (await (
      await SELF.fetch("https://ringbolt.test/api/incidents")
    ).json()) as { incidents: Record<string, unknown>[] };
    expect(list.incidents).toHaveLength(1);
    expect(list.incidents[0]).not.toHaveProperty("callId");

    const response = await SELF.fetch(
      `https://ringbolt.test/api/incidents/${String(list.incidents[0]?.["id"])}`,
    );
    const raw = await response.text();
    const detail = JSON.parse(raw) as {
      incident: Record<string, unknown>;
      events: Record<string, unknown>[];
    };
    expect(detail.incident).not.toHaveProperty("callId");

    // The whole body, not just the incident object. Stripping the field from one half while the
    // `call.placed` event's stored `data` carried it in the other is exactly what this assertion
    // used to miss, and the id is a real value here rather than a shape, so the text is checked.
    expect(detail.events.length).toBeGreaterThan(0);
    for (const event of detail.events) {
      expect(event).not.toHaveProperty("data");
    }
    expect(raw).not.toContain("callId");
    expect(raw).not.toContain("call_fake_");
  });

  /**
   * An alert template rendering an empty variable into this field would otherwise give every
   * service in the estate the same identity, so one incident and one phone call between them all,
   * and one Durable Object serialising the lot. The sender got a 202 and no signal.
   */
  it("rejects a blank fingerprint rather than collapsing the estate into one incident", async () => {
    const response = await postAlert({
      service: "checkout",
      title: "down",
      fingerprint: "",
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("fingerprint");
  });

  /**
   * CALL-E documents the event id as a required header. The body is the half an anonymous caller
   * writes, and this endpoint cannot be authenticated, so a delivery with no header is refused
   * rather than trusted on the body alone.
   */
  it("refuses a delivery with no event id header and writes nothing", async () => {
    const response = await SELF.fetch("https://ringbolt.test/webhooks/calle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_caller_chosen", type: "call.completed" }),
    });

    expect(response.status).toBe(400);
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM processed_events`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  /**
   * The deploy guide recommends sending a stable fingerprint with per-host titles, which is exactly
   * the shape that used to split one incident across two Durable Objects, each writing to a record
   * the other owned.
   */
  it("collapses repeats that share a fingerprint but not a title", async () => {
    const first = await postAlert({
      service: "checkout",
      title: "host-1 cpu",
      fingerprint: "checkout-cpu",
    });
    const second = await postAlert({
      service: "checkout",
      title: "host-2 cpu",
      fingerprint: "checkout-cpu",
    });

    const firstBody = (await first.json()) as { incident: string };
    const secondBody = (await second.json()) as {
      incident: string;
      duplicate: boolean;
    };

    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.incident).toBe(firstBody.incident);
    expect(await new Repo(env.DB).listIncidents()).toHaveLength(1);
  });

  it("collapses a repeat of the same alert into the open incident", async () => {
    const first = await postAlert({
      service: "checkout",
      title: "Payment errors above 20 percent",
    });
    const firstBody = (await first.json()) as { incident: string };

    const second = await postAlert({
      service: "checkout",
      title: "Payment errors above 20 percent",
    });
    const secondBody = (await second.json()) as {
      incident: string;
      duplicate: boolean;
    };

    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.incident).toBe(firstBody.incident);

    const incidents = await new Repo(env.DB).listIncidents();
    expect(incidents).toHaveLength(1);
  });

  it("rejects an alert that does not match the shape", async () => {
    const response = await postAlert({ title: "no service named" });
    expect(response.status).toBe(422);
  });

  it("rejects an unknown intake token", async () => {
    const response = await postAlert(
      { service: "checkout", title: "down" },
      "not-the-token",
    );
    expect(response.status).toBe(404);
  });

  it("stores what the monitor sent about when the problem began", async () => {
    const response = await postAlert({
      service: "checkout",
      title: "Payment errors above 20 percent",
      startedAt: "2026-08-21T14:02:00.000Z",
      links: [
        { label: "dashboard", url: "https://status.example.com/checkout" },
      ],
    });
    const accepted = (await response.json()) as { incident: string };

    const incident = await new Repo(env.DB).getIncident(accepted.incident);
    expect(incident?.startedAt).toBe("2026-08-21T14:02:00.000Z");
    expect(incident?.links).toEqual([
      { label: "dashboard", url: "https://status.example.com/checkout" },
    ]);
  });
});
