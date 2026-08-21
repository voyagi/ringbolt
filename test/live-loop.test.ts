import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REAL_CALL_ALLOWANCE } from "../src/calle/port.js";
import { verifyCall } from "../src/calle/verify.js";
import { Repo } from "../src/db/repo.js";
import type { AlertPayload } from "../src/domain/incident.js";
import { readConfig } from "../src/worker/env.js";
import {
  buildOrchestrator,
  buildPlacer,
  immediateScheduler,
} from "../src/worker/wiring.js";
import { type CalleApiStub, calleApiStub } from "./support/calle-api.js";

/**
 * The same loop `test/loop.test.ts` runs against the stand-in, run again through the CALL-E
 * adapter. Everything on this path is the shipping code: the live placer, the SDK, the request
 * building, the verification step, the authorization gate and the action. Only the socket is
 * replaced, so the branch that only ever runs when a real telephone is involved is not left to be
 * proven by the handful of calls the allowance can pay for.
 */
const LIVE_ENV = {
  RINGBOLT_ENV: "production",
  CALLE_MODE: "live",
  PUBLIC_BASE_URL: "https://ringbolt.example.com",
  INTAKE_TOKEN: "a-long-enough-intake-token",
  CALLE_API_KEY: "test-key-live-loop",
  DEMO_PHONE: "+31612345678",
};

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

function liveOrchestrator(api: CalleApiStub) {
  return buildOrchestrator(env, readConfig(LIVE_ENV), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
    calleFetch: api.fetch,
  });
}

function livePlacer(api: CalleApiStub) {
  return buildPlacer(env, readConfig(LIVE_ENV), {
    scheduler: immediateScheduler,
    calleFetch: api.fetch,
  });
}

describe("the loop running on the CALL-E adapter", () => {
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
    const api = calleApiStub();
    const orchestrator = liveOrchestrator(api);

    const opened = await orchestrator.open(alert);
    if (opened.kind !== "created") throw new Error("the incident was not made");
    const incident = opened.incident;
    expect(incident.state).toBe("calling");

    // The responder picks up and authorizes the kill switch. This is the shape CALL-E returns
    // when the call task carried a result schema and the conversation satisfied it.
    const callId = incident.callId;
    if (callId === null) throw new Error("no call was recorded");
    api.settle(callId, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 0.95, label: "high" },
      structured_result: {
        decision: "run_action",
        action_id: "kill_switch",
        reason: "Turn it off while we look at it.",
      },
      summary: "The responder authorized the kill switch.",
    });

    // Exactly what the webhook route does: re-read the call from the API under our own key rather
    // than believe the unsigned delivery, then hand that snapshot to the incident.
    const snapshot = await verifyCall(livePlacer(api), callId);
    await orchestrator.onCallTerminal(snapshot);

    const repo = new Repo(env.DB);
    const settled = await repo.getIncident(incident.id);
    expect(settled?.state).toBe("resolved");
    expect(await repo.getServiceState("checkout")).toMatchObject({
      killSwitch: true,
    });
  });

  /**
   * What CALL-E reports as `call.result_validation_failed`: the conversation happened and it is
   * confident the task was done, but nothing it heard fits the requested schema, so the task-level
   * result comes back null. A responder said something and it could not be pinned down, which is
   * the exact case this product exists to escalate rather than guess at.
   */
  it("escalates when the call completed but no decision could be pinned down", async () => {
    const api = calleApiStub();
    const orchestrator = liveOrchestrator(api);

    const opened = await orchestrator.open(alert);
    if (opened.kind !== "created") throw new Error("the incident was not made");
    const callId = opened.incident.callId;
    if (callId === null) throw new Error("no call was recorded");

    api.settle(callId, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 0.95, label: "high" },
      structured_result: null,
      summary: "The responder was reached but no decision could be extracted.",
    });

    await orchestrator.onCallTerminal(
      await verifyCall(livePlacer(api), callId),
    );

    const repo = new Repo(env.DB);
    expect((await repo.getIncident(opened.incident.id))?.state).toBe(
      "escalating",
    );
    const runs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_runs`,
    ).first<{ n: number }>();
    expect(runs?.n).toBe(0);
    expect(await repo.getServiceState("checkout")).toBeNull();
  });

  /** A real call is dialled at the configured number, and the API is told to call that number. */
  it("dials the configured number and nothing else", async () => {
    const api = calleApiStub();
    await liveOrchestrator(api).open(alert);

    expect(api.creates[0]?.body["recipients"]).toEqual([
      { phones: ["+31612345678"] },
    ]);
  });

  it("counts the call against the allowance the product reports", async () => {
    const api = calleApiStub();
    await liveOrchestrator(api).open(alert);

    expect(await new Repo(env.DB).countRealCalls()).toBe(1);
  });

  /**
   * The allowance running out must close the incident rather than leave it open, because an open
   * incident answers every later repeat of that alert as a duplicate and the service goes quiet.
   */
  it("closes the incident instead of leaving it open when the allowance is gone", async () => {
    const repo = new Repo(env.DB);
    for (let spent = 0; spent < REAL_CALL_ALLOWANCE; spent += 1) {
      await repo.recordRealCall(
        `call_already_spent_${spent}`,
        `inc_spent_${spent}`,
        "2026-08-21T10:00:00.000Z",
        "live",
      );
    }

    const api = calleApiStub();
    const result = await liveOrchestrator(api).open(alert);

    expect(result.kind).toBe("call_failed");
    expect(result.incident.state).toBe("failed");
    expect(api.creates).toHaveLength(0);
  });
});
