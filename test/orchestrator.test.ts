import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type CallPlacer,
  type CallSnapshot,
  CallNotAttemptedError,
  type PlaceCallInput,
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
  unscheduledWakes,
} from "../src/worker/wiring.js";
import { testActions } from "./support/actions.js";
import { resetTables } from "./support/reset.js";

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

/**
 * Branded the way verifyCall brands a checked API response: a CallSnapshot, then the cast. The
 * tests write the snapshot themselves, so nothing else can put the brand on it.
 */
function snapshotFor(incident: Incident, decision: unknown): VerifiedCall {
  const snapshot: CallSnapshot = {
    id: "call_stub",
    status: "completed",
    taskCompleted: true,
    confidenceScore: 0.94,
    confidenceLabel: "high",
    structuredResult: decision,
    summary: "The responder was reached and gave a decision.",
    evidence: [],
    // A call where somebody was heard. The gate refuses a decision with no responder speech behind
    // it, so a snapshot with an empty transcript is not a call that reached anybody.
    transcript: [
      { offsetSeconds: 0, speaker: "bot", text: "This is Ringbolt." },
      { offsetSeconds: 8, speaker: "user", text: "Understood." },
    ],
    metadata: { incident_id: incident.id, service: incident.service },
    failureCode: null,
  };
  return snapshot as VerifiedCall;
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
    fallbackPhone: "+00000000000",
    now: () => new Date(),
    newId,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
    actions: testActions(),
  });
}

async function anIncidentWaitingOnADecision(): Promise<Incident> {
  const orchestrator = buildOrchestrator(env, readConfig(env), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
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

async function countActionRuns(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM action_runs`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("what the responder said decides where the incident lands", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
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
   *
   * With no rotation configured there is exactly one person to call, so escalating has nowhere to
   * go and the incident closes rather than sitting on the alert. Handing it to a second contact is
   * covered in rotation.test.ts, which is where a rotation exists.
   */
  it("escalates when the responder asked to, and closes when there is nobody else", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "escalate", reason: "not my system" }),
    );

    const after = await stateOf(incident.id);
    expect(after.state).toBe("failed");
    expect(after.outcome).toBe("escalation_exhausted");

    const kinds = (await new Repo(env.DB).listEvents(incident.id)).map(
      (event) => event.kind,
    );
    expect(kinds).toContain("action.refused");
    expect(kinds).toContain("incident.escalation_exhausted");
  });

  it("snoozes with the minutes kept rather than parsed and dropped", async () => {
    const incident = await anIncidentWaitingOnADecision();
    const before = Date.now();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "snooze", snooze_minutes: 45 }),
    );

    const snoozed = await stateOf(incident.id);
    expect(snoozed.state).toBe("snoozed");
    const events = await new Repo(env.DB).listEvents(incident.id);
    const refusal = events.find((event) => event.kind === "action.refused");
    expect(refusal?.data).toMatchObject({
      decision: "snooze",
      snoozeMinutes: 45,
    });

    // The deadline is a value the sweep can read, not a sentence in the audit trail.
    expect(snoozed.wakeAt).not.toBeNull();
    expect(Date.parse(snoozed.wakeAt ?? "")).toBeGreaterThanOrEqual(
      before + 45 * 60_000,
    );
  });

  it("ignores a snapshot for a call that has not finished", async () => {
    const incident = await anIncidentWaitingOnADecision();
    const running = {
      ...snapshotFor(incident, {
        decision: "run_action",
        action_id: "kill_switch",
      }),
      status: "in_progress" as const,
    } as VerifiedCall;

    await orchestratorWith(stubPlacer("fake")).onCallTerminal(running);

    expect((await stateOf(incident.id)).state).toBe("calling");
  });

  /**
   * A decision Ringbolt could not trust goes to a person, not to a bin. With nobody else in the
   * rotation that person does not exist, so the incident closes and names why rather than holding
   * the alert open and silencing every later repeat of it.
   */
  it("sends a decision below the confidence floor to the rotation", async () => {
    const incident = await anIncidentWaitingOnADecision();
    const snapshot = snapshotFor(incident, { decision: "run_action" });
    await orchestratorWith(stubPlacer("fake")).onCallTerminal({
      ...snapshot,
      confidenceScore: 0.2,
    } as VerifiedCall);

    expect((await stateOf(incident.id)).state).toBe("failed");
    const refusal = (await new Repo(env.DB).listEvents(incident.id)).find(
      (event) => event.kind === "action.refused",
    );
    expect(refusal?.data).toMatchObject({
      refusal: "confidence_below_floor",
    });
    expect(await countActionRuns()).toBe(0);
  });

  /**
   * The set that authorizes has to be the set the responder heard. Recomputing the offer when the
   * decision comes back would authorize against whatever policy says minutes later, which is the
   * same defect as looking an action id up in a different list, one level further out. Phase 3 is
   * when actionsFor starts filtering per service, and that is when a policy edit during a call
   * would otherwise let through an action nobody read out.
   */
  it("refuses an action that was not read out on the call", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await env.DB.prepare(
      `UPDATE incidents SET offered_actions = ?2 WHERE id = ?1`,
    )
      .bind(incident.id, JSON.stringify(["rollback"]))
      .run();

    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, {
        decision: "run_action",
        action_id: "kill_switch",
      }),
    );

    // Nothing ran, which is the property. Where the incident went afterwards is the rotation's
    // business, and the reason it was refused is on the event rather than on the row, because the
    // row's outcome carries the final disposition.
    expect(await countActionRuns()).toBe(0);
    const refusal = (await new Repo(env.DB).listEvents(incident.id)).find(
      (event) => event.kind === "action.refused",
    );
    expect(refusal?.data).toMatchObject({ refusal: "action_not_offered" });
    expect((await stateOf(incident.id)).state).toBe("failed");
  });

  it("records what was read out so the decision can be checked against it", async () => {
    const incident = await anIncidentWaitingOnADecision();
    expect((await stateOf(incident.id)).offeredActions).toEqual([
      "kill_switch",
      "rollback",
    ]);
  });

  it("a snoozed incident still collapses a repeat of the same alert", async () => {
    const incident = await anIncidentWaitingOnADecision();
    await orchestratorWith(stubPlacer("fake")).onCallTerminal(
      snapshotFor(incident, { decision: "snooze", snooze_minutes: 45 }),
    );

    const repeat = await buildOrchestrator(env, readConfig(env), {
      scheduler: immediateScheduler,
      exclusive: (work) => work(),
      wake: unscheduledWakes,
    }).open(alert);
    expect(repeat.kind).toBe("duplicate");
  });
});

/**
 * A create that failed is not a create that did not happen. CALL-E confirmed on 2026-08-24 that a
 * response which never reaches the client does not cancel a call they already accepted, and that a
 * repeat carrying a different key is billed as a separate call. So the repeat carries the same key,
 * and a refusal raised before anything went out is not repeated at all.
 */
describe("a request that may or may not have reached the provider", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  function recordingPlacer(fail: () => Error): {
    placer: CallPlacer;
    sent: string[];
  } {
    const sent: string[] = [];
    return {
      sent,
      placer: {
        ...stubPlacer("live"),
        async place(input: PlaceCallInput): Promise<CallSnapshot> {
          sent.push(input.idempotencyKey);
          throw fail();
        },
      },
    };
  }

  it("sends it exactly twice, under one key, and says the outcome is unknown", async () => {
    const { placer, sent } = recordingPlacer(
      () => new Error("The operation was aborted due to timeout"),
    );

    const result = await orchestratorWith(placer).open(alert);

    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(1);
    expect(result.incident.outcome).toBe("call_outcome_unknown");
    expect(result.kind === "call_failed" && result.detail).toContain(
      "a call may exist",
    );
  });

  it("does not repeat one our own guards refused, because nothing was sent", async () => {
    const { placer, sent } = recordingPlacer(
      () => new CallNotAttemptedError("that number is not on the list"),
    );

    const result = await orchestratorWith(placer).open(alert);

    expect(sent).toHaveLength(1);
    expect(result.incident.outcome).toBe("call_place_refused");
    expect(result.kind === "call_failed" && result.detail).not.toContain(
      "may exist",
    );
  });
});

describe("a telephone that will not dial", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
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

/**
 * The product reports money, because money is what CALL-E charges: a call task costs five cents
 * whether or not it ever connects. It reported a count against a hardcoded allowance of twenty
 * until 2026-08-24, which was a figure nobody had chosen measuring a thing nobody is billed for.
 */
describe("the real-call budget", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  it("counts what a call placed by a real placer costs", async () => {
    await orchestratorWith(stubPlacer("live")).open(alert);

    const budget = await SELF.fetch("https://ringbolt.test/api/budget");
    expect(await budget.json()).toMatchObject({
      realCallsPlaced: 1,
      callPriceUsd: 0.05,
      spentUsd: 0.05,
    });
  });

  it("does not count a call placed by the local stand-in", async () => {
    await orchestratorWith(stubPlacer("fake")).open(alert);

    const budget = await SELF.fetch("https://ringbolt.test/api/budget");
    expect(await budget.json()).toMatchObject({
      realCallsPlaced: 0,
      spentUsd: 0,
    });
  });

  /** The test environment has no credit configured, and that is what a fresh deployment looks like. */
  it("reports nothing to spend until somebody says what may be spent", async () => {
    const budget = await SELF.fetch("https://ringbolt.test/api/budget");
    expect(await budget.json()).toMatchObject({
      creditUsd: 0,
      remainingUsd: 0,
      callsRemaining: 0,
    });
  });
});
