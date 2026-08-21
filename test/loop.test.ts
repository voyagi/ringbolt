import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSnapshot } from "../src/calle/port.js";
import { Repo } from "../src/db/repo.js";

const TOKEN = "test-intake-token-0123456789";

async function postAlert(body: unknown, token = TOKEN): Promise<Response> {
  return SELF.fetch(`https://ringbolt.test/intake/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function terminalCallFor(incidentId: string): Promise<CallSnapshot> {
  return vi.waitFor(
    async () => {
      const row = await env.DB.prepare(`SELECT snapshot FROM fake_calls`).all<{
        snapshot: string;
      }>();
      const snapshots = row.results.map(
        (r) => JSON.parse(r.snapshot) as CallSnapshot,
      );
      const match = snapshots.find(
        (snapshot) =>
          snapshot.metadata["incident_id"] === incidentId &&
          snapshot.status !== "queued",
      );
      if (match === undefined)
        throw new Error("the call has not reached a terminal state yet");
      return match;
    },
    { timeout: 5000, interval: 25 },
  );
}

async function deliverWebhook(
  call: CallSnapshot,
  eventId = `evt_${crypto.randomUUID()}`,
): Promise<Response> {
  return SELF.fetch("https://ringbolt.test/webhooks/calle", {
    method: "POST",
    headers: { "content-type": "application/json", "CALL-E-Event-Id": eventId },
    body: JSON.stringify({
      id: eventId,
      type: "call.completed",
      created_at: new Date().toISOString(),
      data: { id: call.id, status: call.status, metadata: call.metadata },
    }),
  });
}

describe("the whole loop", () => {
  beforeEach(async () => {
    for (const table of [
      "incident_events",
      "action_runs",
      "processed_events",
      "call_ledger",
      "incidents",
      "service_state",
      "fake_calls",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
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

    const call = await terminalCallFor(accepted.incident);
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
    const call = await terminalCallFor(accepted.incident);

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

  it("reports a real-call budget that the fake never spends", async () => {
    await postAlert({ service: "checkout", title: "down" });
    const budget = await SELF.fetch("https://ringbolt.test/api/budget");
    expect(await budget.json()).toMatchObject({
      realCallsPlaced: 0,
      remaining: 20,
    });
  });
});
