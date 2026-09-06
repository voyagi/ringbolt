import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionEnvironment } from "../src/domain/orchestrator.js";
import { actionDefinitionInput } from "../src/actions/definition.js";
import type {
  CallPlacer,
  CallSnapshot,
  PlaceCallInput,
} from "../src/calle/port.js";
import type { VerifiedCall } from "../src/calle/verify.js";
import { Repo } from "../src/db/repo.js";
import type { AlertPayload, Incident } from "../src/domain/incident.js";
import { Orchestrator } from "../src/domain/orchestrator.js";
import { defaultPolicy } from "../src/domain/policy.js";
import { newId, unscheduledWakes } from "../src/worker/wiring.js";
import { jsonResponse, testActions } from "./support/actions.js";
import { resetTables } from "./support/reset.js";

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

const placed: PlaceCallInput[] = [];

const placer: CallPlacer = {
  kind: "fake",
  async place(input: PlaceCallInput): Promise<CallSnapshot> {
    placed.push(input);
    return {
      id: `call_${placed.length}`,
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
    throw new Error("this stub only places");
  },
};

// The brand on VerifiedCall is what verifyCall adds after checking a real API response. These
// tests hand the orchestrator a snapshot they wrote themselves, so they put the brand on the same
// way verifyCall does: a checked CallSnapshot, then the cast.
function decided(incident: Incident, decision: unknown): VerifiedCall {
  const snapshot: CallSnapshot = {
    id: "call_1",
    status: "completed",
    taskCompleted: true,
    confidenceScore: 0.93,
    confidenceLabel: "high",
    structuredResult: decision,
    summary: "The responder was reached and gave a decision.",
    evidence: ["responder confirmed the decision out loud"],
    transcript: [
      { offsetSeconds: 0, speaker: "bot", text: "This is Ringbolt." },
      { offsetSeconds: 7, speaker: "user", text: "Restart the workers." },
    ],
    metadata: { incident_id: incident.id, service: incident.service },
    failureCode: null,
  };
  return snapshot as VerifiedCall;
}

function orchestrator(actions: ActionEnvironment): Orchestrator {
  return new Orchestrator({
    repo: new Repo(env.DB),
    placer,
    publicBaseUrl: "https://ringbolt.test",
    fallbackPhone: "+00000000000",
    now: () => new Date(),
    newId,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
    actions,
  });
}

async function opened(actions: ActionEnvironment): Promise<Incident> {
  const result = await orchestrator(actions).open(alert);
  if (result.kind !== "created") throw new Error("the incident was not opened");
  return result.incident;
}

/** An action an operator wrote down, stored the way the configuration endpoint stores one. */
async function defineRestartAction(
  extra: Record<string, unknown> = {},
): Promise<void> {
  const parsed = actionDefinitionInput.parse({
    label: "Restart the workers",
    spokenDescription: "restart the workers, which drops every job in flight",
    confirmationPhrase: "restart the workers",
    parameters: [
      {
        name: "reason",
        description: "why, in their own words",
        type: "string",
      },
    ],
    target: {
      kind: "http",
      method: "POST",
      url: "https://deploy.example.com/services/checkout/restart",
      body: { reason: "{reason}" },
    },
    ...extra,
  });

  await new Repo(env.DB).upsertActionDefinition({
    ...parsed,
    id: "restart_workers",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
  });
}

const healthy = {
  url: "https://deploy.example.com/services/checkout/health",
  jsonPath: ["status", "healthy"],
  equals: true,
  attempts: 2,
  delayMs: 0,
  timeoutMs: 5_000,
};

function transport(answers: (method: string) => Response) {
  const sent: { method: string; body: string }[] = [];
  const http: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    sent.push({
      method,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return answers(method);
  };
  return { sent, http };
}

describe("an action an operator defined rather than one that was compiled in", () => {
  beforeEach(async () => {
    placed.length = 0;
    await resetTables(env.DB);
  });

  it("is offered on the call as soon as it exists", async () => {
    await defineRestartAction();
    const incident = await opened(testActions());

    expect(incident.offeredActions).toContain("restart_workers");
    expect(placed[0]?.task).toContain("restart the workers");
    expect(placed[0]?.task).toContain("Ask them for: reason");
  });

  it("runs on the responder's word and leaves a record a person can read", async () => {
    await defineRestartAction({ verify: healthy });
    const { sent, http } = transport((method) =>
      method === "POST"
        ? jsonResponse({ ok: true })
        : jsonResponse({ status: { healthy: true } }),
    );

    const incident = await opened(testActions({ http }));
    await orchestrator(testActions({ http })).onCallTerminal(
      decided(incident, {
        decision: "run_action",
        action_id: "restart_workers",
        confirmation_phrase: "restart the workers",
        action_parameters: { reason: "the queue is jammed" },
        reason: "the queue is jammed",
      }),
    );

    // The first request out is the check reading the system BEFORE the change, which is what makes
    // the before and after in the audit record two readings rather than one and an assumption.
    expect(sent[0]?.method).toBe("GET");
    const changed = sent.find((one) => one.method === "POST");
    expect(JSON.parse(changed?.body ?? "{}")).toEqual({
      reason: "the queue is jammed",
    });

    const repo = new Repo(env.DB);
    const after = await repo.getIncident(incident.id);
    expect(after?.state).toBe("resolved");
    expect(after?.outcome).toBe("restart_workers:succeeded");

    const [run] = await repo.listActionRuns(incident.id);
    expect(run).toMatchObject({
      actionId: "restart_workers",
      callId: "call_1",
      authorizedBy: "the configured responder",
      parameters: { reason: "the queue is jammed" },
      outcome: "succeeded",
      attempts: 1,
      verification: { verified: true },
    });
    expect(run?.decision).toMatchObject({ action_id: "restart_workers" });
    expect(run?.stateBefore).not.toBeNull();
    expect(run?.stateAfter).not.toBeNull();

    const [call] = await repo.listCallRecords(incident.id);
    expect(call).toMatchObject({ callId: "call_1", status: "completed" });
    expect(call?.transcript).toHaveLength(2);
  });

  /**
   * The request was accepted and the system did not change. An incident that resolves on that is
   * Ringbolt telling somebody a production problem is fixed because a request returned 200.
   */
  it("does not resolve an incident on an action nothing could confirm", async () => {
    await defineRestartAction({ verify: healthy });
    const { http } = transport((method) =>
      method === "POST"
        ? jsonResponse({ ok: true })
        : jsonResponse({ status: { healthy: false } }),
    );

    const incident = await opened(testActions({ http }));
    await orchestrator(testActions({ http })).onCallTerminal(
      decided(incident, {
        decision: "run_action",
        action_id: "restart_workers",
        confirmation_phrase: "restart the workers",
        action_parameters: { reason: "the queue is jammed" },
      }),
    );

    const repo = new Repo(env.DB);
    const after = await repo.getIncident(incident.id);
    expect(after?.state).toBe("failed");
    expect(after?.outcome).toBe("restart_workers:unverified");

    const [run] = await repo.listActionRuns(incident.id);
    expect(run).toMatchObject({
      outcome: "unverified",
      verification: { verified: false },
    });
  });

  it("is never offered, and cannot run, when the service's policy leaves it out", async () => {
    await defineRestartAction();
    await new Repo(env.DB).upsertServicePolicy({
      ...defaultPolicy("checkout", ["kill_switch"], "2026-08-22T10:00:00.000Z"),
    });

    const { sent, http } = transport(() => jsonResponse({ ok: true }));
    const incident = await opened(testActions({ http }));
    expect(incident.offeredActions).toEqual(["kill_switch"]);

    await orchestrator(testActions({ http })).onCallTerminal(
      decided(incident, {
        decision: "run_action",
        action_id: "restart_workers",
        confirmation_phrase: "restart the workers",
        action_parameters: { reason: "because" },
      }),
    );

    expect(sent).toHaveLength(0);
    const repo = new Repo(env.DB);
    expect(await repo.listActionRuns(incident.id)).toHaveLength(0);
    const refusal = (await repo.listEvents(incident.id)).find(
      (event) => event.kind === "action.refused",
    );
    expect(refusal?.data).toMatchObject({ refusal: "action_not_offered" });
  });

  /**
   * An action can be edited or removed while the call is still going. The set that authorizes is
   * the intersection of what was read out and what exists now, so a definition that has since gone
   * cannot be run against a decision that named it.
   */
  it("cannot be run after it has been deleted mid-call", async () => {
    await defineRestartAction();
    const { sent, http } = transport(() => jsonResponse({ ok: true }));
    const incident = await opened(testActions({ http }));
    expect(incident.offeredActions).toContain("restart_workers");

    await new Repo(env.DB).deleteActionDefinition("restart_workers");

    await orchestrator(testActions({ http })).onCallTerminal(
      decided(incident, {
        decision: "run_action",
        action_id: "restart_workers",
        confirmation_phrase: "restart the workers",
        action_parameters: { reason: "because" },
      }),
    );

    expect(sent).toHaveLength(0);
    expect(await new Repo(env.DB).listActionRuns(incident.id)).toHaveLength(0);
  });

  /**
   * The other half of the same rule, and the one the offered set cannot catch: the action WAS read
   * out, and the policy stopped permitting it while the responder was still on the phone. The set
   * that authorizes is the intersection, so it cannot run.
   */
  it("cannot be run after the policy withdrew it mid-call", async () => {
    await defineRestartAction();
    const { sent, http } = transport(() => jsonResponse({ ok: true }));
    const incident = await opened(testActions({ http }));
    expect(incident.offeredActions).toContain("restart_workers");

    await new Repo(env.DB).upsertServicePolicy(
      defaultPolicy("checkout", ["kill_switch"], "2026-08-22T10:00:00.000Z"),
    );

    await orchestrator(testActions({ http })).onCallTerminal(
      decided(incident, {
        decision: "run_action",
        action_id: "restart_workers",
        confirmation_phrase: "restart the workers",
        action_parameters: { reason: "because" },
      }),
    );

    expect(sent).toHaveLength(0);
    const repo = new Repo(env.DB);
    expect(await repo.listActionRuns(incident.id)).toHaveLength(0);
    const refusal = (await repo.listEvents(incident.id)).find(
      (event) => event.kind === "action.refused",
    );
    expect(refusal?.data).toMatchObject({ refusal: "action_not_offered" });
  });

  it("refuses a value the action would not accept, and sends nothing", async () => {
    await defineRestartAction({
      parameters: [
        {
          name: "instances",
          description: "how many to run",
          type: "number",
          min: 1,
          max: 10,
        },
      ],
      target: {
        kind: "http",
        method: "POST",
        url: "https://deploy.example.com/services/checkout/scale",
        body: { instances: "{instances}" },
      },
    });

    const { sent, http } = transport(() => jsonResponse({ ok: true }));
    const incident = await opened(testActions({ http }));
    await orchestrator(testActions({ http })).onCallTerminal(
      decided(incident, {
        decision: "run_action",
        action_id: "restart_workers",
        confirmation_phrase: "restart the workers",
        action_parameters: { instances: "four hundred" },
      }),
    );

    expect(sent).toHaveLength(0);
    const refusal = (await new Repo(env.DB).listEvents(incident.id)).find(
      (event) => event.kind === "action.refused",
    );
    expect(refusal?.data).toMatchObject({ refusal: "parameters_invalid" });
  });

  it("keeps the transcript even when the decision was refused", async () => {
    const incident = await opened(testActions());
    await orchestrator(testActions()).onCallTerminal(
      decided(incident, { decision: "hold", reason: "leave it running" }),
    );

    const [call] = await new Repo(env.DB).listCallRecords(incident.id);
    expect(call?.transcript).toHaveLength(2);
    expect(call?.structuredResult).toMatchObject({ decision: "hold" });
  });
});
