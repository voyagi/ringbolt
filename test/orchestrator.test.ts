import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CallPlacer,
  CallSnapshot,
  PlaceCallInput,
} from "../src/calle/port.js";
import type { VerifiedCall } from "../src/calle/verify.js";
import { Repo } from "../src/db/repo.js";
import type { AlertPayload, Incident } from "../src/domain/incident.js";
import { Orchestrator } from "../src/domain/orchestrator.js";
import { readConfig } from "../src/worker/env.js";
import {
  buildOrchestrator,
  immediateScheduler,
  newId,
} from "../src/worker/wiring.js";

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

function snapshotFor(incident: Incident, decision: unknown): VerifiedCall {
  return {
    id: "call_stub",
    status: "completed",
    taskCompleted: true,
    confidenceScore: 0.94,
    confidenceLabel: "high",
    structuredResult: decision,
    summary: "The responder was reached and gave a decision.",
    evidence: [],
    transcript: [],
    metadata: { incident_id: incident.id, service: incident.service },
    failureCode: null,
  } as VerifiedCall;
}

/** A placer that reports itself as the real one without dialling anything. */
function stubPlacer(kind: "live" | "fake"): CallPlacer {
  return {
    kind,
    async place(input: PlaceCallInput): Promise<CallSnapshot> {
      return {
        id: `call_${kind}_${input.idempotencyKey}`,
        status: "queued",
        taskCompleted: null,
        confidenceScore: null,
        confidenceLabel: null,
        structuredResult: null,
        summary: null,
        evidence: [],
        transcript: [],
        metadata: input.metadata,
        failureCode: null,
      };
    },
    async get(): Promise<CallSnapshot> {
      throw new Error("this stub is only used to place");
    },
  };
}

function orchestratorWith(placer: CallPlacer): Orchestrator {
  return new Orchestrator({
    repo: new Repo(env.DB),
    placer,
    publicBaseUrl: "https://ringbolt.test",
    responderPhone: "+00000000000",
    now: () => new Date(),
    newId,
    exclusive: (work) => work(),
  });
}

async function anIncidentWaitingOnADecision(): Promise<Incident> {
  const orchestrator = buildOrchestrator(env, readConfig(env), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
  });
  const opened = await orchestrator.open(alert);
  if (opened.kind !== "created")
    throw new Error("the incident was not created");
  return opened.incident;
}

async function stateOf(id: string): Promise<Incident> {
  const incident = await new Repo(env.DB).getIncident(id);
  if (incident === null) throw new Error("the incident vanished");
  return incident;
}

describe("what the responder said decides where the incident lands", () => {
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

  it("holds only when the responder asked for a hold", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "hold", reason: "leave it running" }),
    );
    expect((await stateOf(incident.id)).state).toBe("held");
  });

  /**
   * The inversion this replaces: an explicit spoken escalation used to land in `held`, which has no
   * way out at all, while a call nobody picked up went to `escalating`. A human who answered and
   * asked for help was being treated as less urgent than silence.
   */
  it("escalates when the responder asked to escalate", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "escalate", reason: "not my system" }),
    );
    expect((await stateOf(incident.id)).state).toBe("escalating");
  });

  it("snoozes with the minutes kept rather than parsed and dropped", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "snooze", snooze_minutes: 45 }),
    );

    expect((await stateOf(incident.id)).state).toBe("snoozed");
    const events = await new Repo(env.DB).listEvents(incident.id);
    const refusal = events.find((event) => event.kind === "action.refused");
    expect(refusal?.data).toMatchObject({
      decision: "snooze",
      snoozeMinutes: 45,
    });
  });

  it("keeps a mechanical refusal in escalating", async () => {
    const incident = await anIncidentWaitingOnADecision();
    const snapshot = snapshotFor(incident, { decision: "run_action" });
    await orchestratorWith(stubPlacer("fake")).onCallTerminal({
      ...snapshot,
      confidenceScore: 0.2,
    } as VerifiedCall);
    expect((await stateOf(incident.id)).state).toBe("escalating");
  });

  it("a snoozed incident still collapses a repeat of the same alert", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "snooze", snooze_minutes: 45 }),
    );

    const repeat = await buildOrchestrator(env, readConfig(env), {
      scheduler: immediateScheduler,
      exclusive: (work) => work(),
    }).open(alert);
    expect(repeat.kind).toBe("duplicate");
  });
});

describe("a telephone that will not dial", () => {
  beforeEach(async () => {
    for (const table of ["incident_events", "incidents", "fake_calls"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  /**
   * `received` counts as open, so an incident left there would answer every later repeat of this
   * alert as a duplicate of itself and no call would ever be placed for that service again.
   */
  it("closes the incident instead of leaving it open for ever", async () => {
    const failing: CallPlacer = {
      ...stubPlacer("fake"),
      async place(): Promise<CallSnapshot> {
        throw new Error("the call provider is unreachable");
      },
    };

    const result = await orchestratorWith(failing).open(alert);
    expect(result.kind).toBe("call_failed");
    expect((await stateOf(result.incident.id)).state).toBe("failed");

    const retry = await orchestratorWith(stubPlacer("fake")).open(alert);
    expect(retry.kind).toBe("created");
    expect(retry.incident.id).not.toBe(result.incident.id);
  });
});

describe("the real-call budget", () => {
  beforeEach(async () => {
    for (const table of [
      "incident_events",
      "call_ledger",
      "incidents",
      "fake_calls",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it("counts a call placed by a real placer", async () => {
    await orchestratorWith(stubPlacer("live")).open(alert);

    const budget = await SELF.fetch("https://ringbolt.test/api/budget");
    expect(await budget.json()).toMatchObject({
      realCallsPlaced: 1,
      freeTierTotal: 20,
      remaining: 19,
    });
  });

  it("does not count a call placed by the local stand-in", async () => {
    await orchestratorWith(stubPlacer("fake")).open(alert);

    const budget = await SELF.fetch("https://ringbolt.test/api/budget");
    expect(await budget.json()).toMatchObject({
      realCallsPlaced: 0,
      remaining: 20,
    });
  });
});
