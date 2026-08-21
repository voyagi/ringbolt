import { describe, expect, it } from "vitest";
import {
  CallBudgetExhaustedError,
  LiveCallPlacer,
  NumberNotAllowedError,
} from "../src/calle/live.js";
import { REAL_CALL_ALLOWANCE } from "../src/calle/port.js";
import { verifyCall } from "../src/calle/verify.js";
import { decisionResultSchema } from "../src/domain/decision.js";
import {
  type CalleApiStub,
  aRecipient,
  anAttempt,
  calleApiStub,
} from "./support/calle-api.js";

const API_KEY = "test-key-not-a-real-credential";
const OWNED_NUMBER = "+31612345678";

function placerWith(
  api: CalleApiStub,
  spent = 0,
  allowedNumbers: string[] = [OWNED_NUMBER],
): { placer: LiveCallPlacer; api: CalleApiStub } {
  return {
    api,
    placer: new LiveCallPlacer({
      apiKey: API_KEY,
      budget: { spent: async () => spent },
      allowedNumbers,
      baseUrl: "https://calle.invalid",
      fetchImpl: api.fetch,
    }),
  };
}

function anIncidentCall() {
  return {
    phone: OWNED_NUMBER,
    task: "Checkout is returning errors. Ask what to do.",
    resultSchema: decisionResultSchema as unknown as Record<string, unknown>,
    metadata: { incident_id: "inc_live_1", service: "checkout" },
    webhookUrl: "https://ringbolt.example.com/webhooks/calle",
    idempotencyKey: "inc_live_1:attempt-1",
  };
}

describe("what the adapter puts on the wire", () => {
  it("sends the task, the number, the decision schema and the webhook", async () => {
    const { placer, api } = placerWith(calleApiStub());
    await placer.place(anIncidentCall());

    const sent = api.creates[0];
    expect(sent?.body["task"]).toContain("Checkout is returning errors");
    expect(sent?.body["recipients"]).toEqual([{ phones: ["+31612345678"] }]);
    expect(sent?.body["webhook_url"]).toBe(
      "https://ringbolt.example.com/webhooks/calle",
    );
    expect(sent?.body["metadata"]).toEqual({
      incident_id: "inc_live_1",
      service: "checkout",
    });
  });

  /**
   * The whole reason the decision comes back as data rather than prose. Sent under the API's own
   * key name, because a schema sent under the wrong one is silently no schema at all.
   */
  it("sends the decision contract as result_schema", async () => {
    const { placer, api } = placerWith(calleApiStub());
    await placer.place(anIncidentCall());

    const schema = api.creates[0]?.body["result_schema"] as
      Record<string, unknown> | undefined;
    expect(schema?.["required"]).toEqual(["decision"]);
    expect(
      (schema?.["properties"] as { decision?: { enum?: string[] } } | undefined)
        ?.decision?.enum,
    ).toEqual(["run_action", "hold", "escalate", "snooze"]);
  });

  /**
   * A retried create that is not deduplicated is a second telephone ringing at 3am, and that is
   * not recoverable once it has happened.
   */
  it("sends the idempotency key as the header the API deduplicates on", async () => {
    const { placer, api } = placerWith(calleApiStub());
    await placer.place(anIncidentCall());

    expect(api.creates[0]?.idempotencyKey).toBe("inc_live_1:attempt-1");
  });

  it("authenticates with the api key rather than sending it in the body", async () => {
    const { placer, api } = placerWith(calleApiStub());
    await placer.place(anIncidentCall());

    expect(api.creates[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(api.creates[0]?.body)).not.toContain(API_KEY);
  });
});

describe("what the adapter reads back", () => {
  it("flattens the transcript the API nests under each attempt", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "completed",
      recipients: [
        aRecipient([
          anAttempt({
            id: "att_1",
            status: "failed",
            failure_code: "no_answer",
            transcript_turns: [],
          }),
          anAttempt({
            id: "att_2",
            transcript_turns: [
              { offset_seconds: 0, speaker: "bot", text: "Checkout is down." },
              { offset_seconds: 11, speaker: "user", text: "Kill it." },
              { offset_seconds: null, speaker: "unknown", text: "..." },
            ],
          }),
        ]),
      ],
    });

    const read = await placer.get(placed.id);
    expect(read.transcript).toEqual([
      { offsetSeconds: 0, speaker: "bot", text: "Checkout is down." },
      { offsetSeconds: 11, speaker: "user", text: "Kill it." },
      { offsetSeconds: null, speaker: "unknown", text: "..." },
    ]);
  });

  /** The number the authorization floor compares against. Nested one level down in the API. */
  it("lifts the completion confidence the authorization floor reads", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 0.93, label: "high" },
      structured_result: { decision: "hold" },
      evidence: ["the responder said to leave it"],
    });

    const read = await placer.get(placed.id);
    expect(read.confidenceScore).toBe(0.93);
    expect(read.confidenceLabel).toBe("high");
    expect(read.taskCompleted).toBe(true);
    expect(read.structuredResult).toEqual({ decision: "hold" });
    expect(read.evidence).toEqual(["the responder said to leave it"]);
  });

  /**
   * A call that ran out of attempts reports why on the attempt while the task-level code stays
   * null, and that reason is what phase 3 decides the next contact from.
   */
  it("carries the attempt's failure reason when the task itself has none", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "completed",
      recipients: [
        aRecipient([
          anAttempt({ id: "att_1", failure_code: "busy" }),
          anAttempt({ id: "att_2", failure_code: "no_answer" }),
        ]),
      ],
    });

    expect((await placer.get(placed.id)).failureCode).toBe("no_answer");
  });

  it("prefers the task's own failure reason over an attempt's", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "failed",
      failure_code: "recipient_unreachable",
      recipients: [aRecipient([anAttempt({ failure_code: "no_answer" })])],
    });

    expect((await placer.get(placed.id)).failureCode).toBe(
      "recipient_unreachable",
    );
  });

  it("produces a terminal snapshot the verification step accepts", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 0.88, label: "high" },
      structured_result: { decision: "run_action", action_id: "kill_switch" },
    });

    await expect(verifyCall(placer, placed.id)).resolves.toMatchObject({
      id: placed.id,
      confidenceScore: 0.88,
    });
  });

  /**
   * The shape check is the door every snapshot comes through, and a confidence score outside its
   * range did not come from the field the floor is about. Refusing is the fail-closed answer.
   */
  it("is refused by verification when the API returns a confidence out of range", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 93, label: "high" },
    });

    await expect(verifyCall(placer, placed.id)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});

/**
 * A rotation can name any contact anybody added through the configuration endpoint, so without this
 * list the set of telephones a live build can reach is a database table. What it protects against
 * is a real stranger's phone ringing at three in the morning, paid for out of an allowance of
 * twenty calls that cannot be topped up.
 */
describe("the numbers this build may call", () => {
  it("refuses a number that is not on the list, and sends nothing", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);

    await expect(
      placer.place({ ...anIncidentCall(), phone: "+31699999999" }),
    ).rejects.toThrow(NumberNotAllowedError);
    expect(api.creates).toHaveLength(0);
  });

  /** A refusal reaches an audit record and an HTTP response, and the number is still personal data. */
  it("does not repeat the number it refused", async () => {
    const { placer } = placerWith(calleApiStub());

    await expect(
      placer.place({ ...anIncidentCall(), phone: "+31699999999" }),
    ).rejects.toThrow(/^(?!.*\+31699999999).*$/s);
  });

  it("places a call to a second number once that number is on the list", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, 0, [OWNED_NUMBER, "+31698765432"]);

    await expect(
      placer.place({ ...anIncidentCall(), phone: "+31698765432" }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  /**
   * The number is checked before the allowance, so a build with nothing left to spend still says
   * the more important of the two things when both are wrong.
   */
  it("refuses on the number before it refuses on the allowance", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, REAL_CALL_ALLOWANCE);

    await expect(
      placer.place({ ...anIncidentCall(), phone: "+31699999999" }),
    ).rejects.toThrow(NumberNotAllowedError);
  });
});

describe("the real-call allowance", () => {
  it("refuses to place a call once the allowance is spent, and sends nothing", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, REAL_CALL_ALLOWANCE);

    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      CallBudgetExhaustedError,
    );
    expect(api.creates).toHaveLength(0);
  });

  it("places the last one", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, REAL_CALL_ALLOWANCE - 1);

    await expect(placer.place(anIncidentCall())).resolves.toMatchObject({
      status: "queued",
    });
  });

  /**
   * An incident whose call cannot be read is an incident that never resolves, so a spent allowance
   * must not be able to strand the calls it already paid for.
   */
  it("still reads a call back when the allowance is spent", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, 0);
    const placed = await placer.place(anIncidentCall());

    const { placer: broke } = placerWith(api, REAL_CALL_ALLOWANCE);
    await expect(broke.get(placed.id)).resolves.toMatchObject({
      id: placed.id,
    });
  });
});
