import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSnapshot } from "../src/calle/port.js";
import type { VerifiedCall } from "../src/calle/verify.js";
import { Repo } from "../src/db/repo.js";
import { readConfig } from "../src/worker/env.js";
import {
  buildOrchestrator,
  immediateScheduler,
  unscheduledWakes,
} from "../src/worker/wiring.js";
import { resetTables } from "./support/reset.js";

const TOKEN = "test-dummy-intake-token-0123456789";

function orchestrator() {
  return buildOrchestrator(env, readConfig(env), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
  });
}

async function callWaitingOnADecision(): Promise<{
  incidentId: string;
  snapshot: VerifiedCall;
}> {
  const response = await SELF.fetch(`https://ringbolt.test/intake/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service: "checkout",
      title: "Payment errors above 20 percent",
    }),
  });
  const accepted = (await response.json()) as { incident: string };

  const snapshot = await vi.waitFor(
    async () => {
      const rows = await env.DB.prepare(`SELECT snapshot FROM fake_calls`).all<{
        snapshot: string;
      }>();
      const match = rows.results
        .map((row) => JSON.parse(row.snapshot) as CallSnapshot)
        .find(
          (call) =>
            call.metadata["incident_id"] === accepted.incident &&
            call.status !== "queued",
        );
      if (match === undefined) throw new Error("the call is still running");
      return match;
    },
    { timeout: 5000, interval: 25 },
  );

  return {
    incidentId: accepted.incident,
    snapshot: snapshot as VerifiedCall,
  };
}

async function countOf(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

/**
 * An incident goes back into `calling` every time it escalates, and nothing cancels the call it has
 * given up on, so a conversation that outran the ceiling can still deliver its outcome after the
 * next person has been rung. The state test alone passes for that delivery.
 *
 * The state below is written directly rather than reached by waiting out two timeouts, because the
 * identity check is a comparison and this is exactly the row escalation leaves behind: the incident
 * in `calling`, its `call_id` naming the second call, and a terminal snapshot in hand for the
 * first. Reproducing the thirty minutes would test the clock, not the guard.
 */
describe("a delivery for a call the incident has moved on from", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  async function theIncidentIsNowWaitingOnAnotherCall(
    incidentId: string,
  ): Promise<void> {
    await env.DB.prepare(`UPDATE incidents SET call_id = ?1 WHERE id = ?2`)
      .bind("call_fake_the-next-person-in-the-rotation", incidentId)
      .run();
  }

  it("is ignored rather than judged against the current call", async () => {
    const { incidentId, snapshot } = await callWaitingOnADecision();
    await theIncidentIsNowWaitingOnAnotherCall(incidentId);

    await orchestrator().onCallTerminal(snapshot);

    // Nothing ran, nothing was recorded, and the incident kept the move it needs for the call it
    // is actually waiting on.
    expect(await countOf("action_runs")).toBe(0);
    expect(await countOf("call_records")).toBe(0);
    const incident = await new Repo(env.DB).getIncident(incidentId);
    expect(incident?.state).toBe("calling");
    expect(incident?.callId).toBe("call_fake_the-next-person-in-the-rotation");
  });

  /**
   * The positive control. The same snapshot, the same code path, against an incident still waiting
   * on that call: it has to go through, or the test above would pass just as well with the whole
   * handler broken.
   */
  it("is acted on when it is the call the incident is waiting on", async () => {
    const { incidentId, snapshot } = await callWaitingOnADecision();

    await orchestrator().onCallTerminal(snapshot);

    expect(await countOf("call_records")).toBe(1);
    const incident = await new Repo(env.DB).getIncident(incidentId);
    expect(incident?.state).not.toBe("calling");
  });
});
