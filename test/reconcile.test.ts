import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Scheduler } from "../src/calle/port.js";
import { Repo } from "../src/db/repo.js";
import type { AlertPayload } from "../src/domain/incident.js";
import { readConfig } from "../src/worker/env.js";
import { reconcile } from "../src/worker/reconcile.js";
import { buildOrchestrator, immediateScheduler } from "../src/worker/wiring.js";

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

/** The call is placed and then nothing ever resolves it, which is a call still ringing. */
const neverRuns: Scheduler = () => undefined;

const MINUTE = 60 * 1000;

async function openWith(scheduler: Scheduler): Promise<string> {
  const opened = await buildOrchestrator(env, readConfig(env), {
    scheduler,
    exclusive: (work) => work(),
  }).open(alert);
  if (opened.kind !== "created")
    throw new Error("the incident was not created");
  return opened.incident.id;
}

function sweepAt(minutesFromNow: number) {
  return reconcile(env, {
    scheduler: immediateScheduler,
    now: () => new Date(Date.now() + minutesFromNow * MINUTE),
  });
}

async function stateOf(id: string): Promise<string> {
  const incident = await new Repo(env.DB).getIncident(id);
  if (incident === null) throw new Error("the incident vanished");
  return incident.state;
}

describe("the reconciliation sweep", () => {
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

  /**
   * The webhook is the happy path, not a guarantee. Without this sweep the only thing that ever
   * moves an incident out of `calling` is a delivery from the provider, so one lost delivery leaves
   * the incident open for ever, and an open incident answers every later repeat of that alert as a
   * duplicate. A single dropped packet would quietly retire a service's alerts.
   *
   * The stand-in's delivery genuinely does not land here, so this is the real recovery path rather
   * than a simulated one.
   */
  it("finishes a call whose webhook never arrived", async () => {
    const incidentId = await openWith(immediateScheduler);
    expect(await stateOf(incidentId)).toBe("calling");

    const result = await sweepAt(5);

    expect(result).toMatchObject({ examined: 1, finished: 1, abandoned: 0 });
    expect(await stateOf(incidentId)).toBe("resolved");

    const runs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_runs`,
    ).first<{ n: number }>();
    expect(runs?.n).toBe(1);
  });

  it("leaves a call that has only just been placed alone", async () => {
    const incidentId = await openWith(neverRuns);

    const result = await sweepAt(1);

    expect(result).toMatchObject({ examined: 0, finished: 0, abandoned: 0 });
    expect(await stateOf(incidentId)).toBe("calling");
  });

  it("waits for a call that is still running", async () => {
    const incidentId = await openWith(neverRuns);

    const result = await sweepAt(5);

    expect(result).toMatchObject({ examined: 1, finished: 0, abandoned: 0 });
    expect(await stateOf(incidentId)).toBe("calling");
  });

  it("gives up on a call that never reached a terminal state", async () => {
    const incidentId = await openWith(neverRuns);

    const result = await sweepAt(31);

    expect(result).toMatchObject({ examined: 1, abandoned: 1 });
    expect(await stateOf(incidentId)).toBe("escalating");
  });

  it("prunes webhook event ids past their retention window", async () => {
    const repo = new Repo(env.DB);
    await repo.claimEvent("evt_ancient", "2026-01-01T00:00:00.000Z", "");
    await repo.completeEvent("evt_ancient", "2026-01-01T00:00:00.000Z");

    const result = await sweepAt(5);

    expect(result.prunedEvents).toBe(1);
  });
});
