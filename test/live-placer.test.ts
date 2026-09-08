import { describe, expect, it } from "vitest";
import {
  CallBudgetExhaustedError,
  CallBurstError,
  CallRejectedError,
  LiveCallPlacer,
  NumberNotAllowedError,
} from "../src/calle/live.js";
import {
  CALL_PRICE_USD,
  MAX_CALLS_PER_BURST_WINDOW,
} from "../src/calle/port.js";
import {
  SchemaNotSupportedError,
  resultSchemaProblem,
} from "../src/calle/schema.js";
import { verifyCall } from "../src/calle/verify.js";
import { decisionResultSchemaFor } from "../src/domain/decision.js";
import {
  type CalleApiStub,
  aRecipient,
  anAttempt,
  calleApiStub,
} from "./support/calle-api.js";

const API_KEY = "test-dummy-key-not-a-real-credential";
const OWNED_NUMBER = "+31612345678";

/** A dollar, which at five cents a call is twenty of them. */
const CREDIT_USD = 1;
const CALLS_IN_THE_CREDIT = CREDIT_USD / CALL_PRICE_USD;

type Budget = { spent?: number; recent?: number; creditUsd?: number };

function placerWith(
  api: CalleApiStub,
  budget: Budget = {},
  allowedNumbers: string[] = [OWNED_NUMBER],
): { placer: LiveCallPlacer; api: CalleApiStub } {
  return {
    api,
    placer: new LiveCallPlacer({
      apiKey: API_KEY,
      budget: {
        creditUsd: budget.creditUsd ?? CREDIT_USD,
        spent: async () => budget.spent ?? 0,
        placedSince: async () => budget.recent ?? 0,
      },
      allowedNumbers,
      locale: "en-GB",
      region: "NL",
      baseUrl: "https://calle.invalid",
      fetchImpl: api.fetch,
    }),
  };
}

/** Two actions the policy allows on this call, one of which asks the responder for a value. */
const offeredOnTheCall = [
  { id: "kill_switch" },
  {
    id: "scale_out",
    parameters: [
      {
        name: "instances",
        description: "how many instances to run",
        required: true,
        type: "number" as const,
      },
    ],
  },
];

function anIncidentCall() {
  return {
    phone: OWNED_NUMBER,
    task: "Checkout is returning errors. Ask what to do.",
    resultSchema: decisionResultSchemaFor(offeredOnTheCall),
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
    expect(sent?.body["recipients"]).toEqual([
      { phones: ["+31612345678"], locale: "en-GB", region: "NL" },
    ]);
    expect(sent?.body["webhook_url"]).toBe(
      "https://ringbolt.example.com/webhooks/calle",
    );
    expect(sent?.body["metadata"]).toEqual({
      incident_id: "inc_live_1",
      service: "checkout",
    });
  });

  /**
   * Both are optional to CALL-E and both were absent from every call this product has ever placed,
   * all 23 of which came back with nothing the responder said transcribed. `docs/two-way-audio.md`
   * says how far that evidence goes; this test is what stops them quietly going missing again.
   */
  it("says what language the call is in and which country the phone is in", async () => {
    const { placer, api } = placerWith(calleApiStub());
    await placer.place(anIncidentCall());

    const recipient = (
      api.creates[0]?.body["recipients"] as
        Record<string, unknown>[] | undefined
    )?.[0];
    expect(recipient?.["locale"]).toBe("en-GB");
    expect(recipient?.["region"]).toBe("NL");
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
   * Sent under the right key is not the same as sent in a shape they take, which is the gap the
   * 2026-09-08 refusal went through. What goes on the wire is held to their contract here, with the
   * value an action asks for named in it rather than left as an object with any keys.
   */
  it("sends a decision contract CALL-E accepts, naming the value the call asks for", async () => {
    const { placer, api } = placerWith(calleApiStub());
    await placer.place(anIncidentCall());

    const schema = api.creates[0]?.body["result_schema"];
    expect(resultSchemaProblem(schema)).toBeNull();
    expect(schema).toMatchObject({
      properties: {
        action_parameters: {
          additionalProperties: false,
          properties: { instances: { type: "string" } },
        },
      },
    });
  });
});

describe("what the adapter refuses before the wire, and how it reports theirs", () => {
  /**
   * The shape refused on 2026-09-08 must never reach CALL-E again: not because the refusal costs
   * money (it does not, no task is made), but because "result_schema is not supported" tells a
   * person nothing, while this names the field.
   */
  it("refuses a decision schema CALL-E would refuse, and sends nothing", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);

    await expect(
      placer.place({
        ...anIncidentCall(),
        resultSchema: {
          type: "object",
          properties: {
            action_parameters: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
        },
      }),
    ).rejects.toThrow(SchemaNotSupportedError);
    await expect(
      placer.place({
        ...anIncidentCall(),
        resultSchema: { type: "object", additionalProperties: true },
      }),
    ).rejects.toThrow(/result_schema allows properties/);
    expect(api.creates).toHaveLength(0);
  });

  /**
   * Their envelope keeps the explanation under `details.reason` and the message bare. The record a
   * person reads afterwards has to carry the explanation, or the next refusal is diagnosed the way
   * this one was: from their documentation, by hand, days later.
   */
  it("carries CALL-E's own reason and code when they refuse a create", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    api.rejectCreates(1, 422, "result_schema_invalid", 0, {
      reason: "additionalProperties must be false",
    });

    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      CallRejectedError,
    );
    api.rejectCreates(1, 422, "result_schema_invalid", 0, {
      reason: "additionalProperties must be false",
    });
    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      "CALL-E refused this call task. Their reason: additionalProperties must be false (result_schema_invalid)",
    );
  });

  it("reports a refusal that came with no reason as just the message and code", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    api.rejectCreates(1, 400, "invalid_request");

    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      "CALL-E refused this call task. (invalid_request)",
    );
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

  /**
   * The sentence beside the code. On 2026-09-08 a task failed before dialling with
   * `call_not_ready`, which their docs define as something else entirely, and the only thing that
   * explained it was this field, read by hand through their CLI. It is carried now, with the same
   * fallback to the last attempt as the code has.
   */
  it("carries the sentence CALL-E writes beside the failure code", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    api.settle(placed.id, {
      status: "failed",
      failure_code: "call_not_ready",
      failure_message:
        "Call task creation was rejected: Calls to the Netherlands in English are not supported for this call setup.",
    });
    expect((await placer.get(placed.id)).failureMessage).toBe(
      "Call task creation was rejected: Calls to the Netherlands in English are not supported for this call setup.",
    );

    api.settle(placed.id, {
      status: "failed",
      failure_code: null,
      failure_message: null,
      recipients: [
        aRecipient([
          anAttempt({
            failure_code: "no_answer",
            failure_message: "Nobody picked up.",
          }),
        ]),
      ],
    });
    expect((await placer.get(placed.id)).failureMessage).toBe(
      "Nobody picked up.",
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
 * is a real stranger's phone ringing at three in the morning, billed to the owner.
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
    const { placer } = placerWith(api, {}, [OWNED_NUMBER, "+31698765432"]);

    await expect(
      placer.place({ ...anIncidentCall(), phone: "+31698765432" }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  /**
   * The number is checked before the credit, so a build with nothing left to spend still says the
   * more important of the two things when both are wrong.
   */
  it("refuses on the number before it refuses on the credit", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, { spent: CALLS_IN_THE_CREDIT });

    await expect(
      placer.place({ ...anIncidentCall(), phone: "+31699999999" }),
    ).rejects.toThrow(NumberNotAllowedError);
  });
});

describe("what this build may spend", () => {
  it("refuses to place a call once the credit is spent, and sends nothing", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, { spent: CALLS_IN_THE_CREDIT });

    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      CallBudgetExhaustedError,
    );
    expect(api.creates).toHaveLength(0);
  });

  it("places the last one the credit covers", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, { spent: CALLS_IN_THE_CREDIT - 1 });

    await expect(placer.place(anIncidentCall())).resolves.toMatchObject({
      status: "queued",
    });
  });

  /**
   * The ceiling used to be a count of twenty compiled into the source, which was both the wrong
   * unit and nobody's decision. A deployment that has not said what it may spend spends nothing.
   */
  it("refuses everything when nobody has said what may be spent", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, { creditUsd: 0 });

    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      /CALLE_CREDIT_USD/,
    );
    expect(api.creates).toHaveLength(0);
  });

  /**
   * An incident whose call cannot be read is an incident that never resolves, so a spent balance
   * must not be able to strand the calls it already paid for.
   */
  it("still reads a call back when the credit is spent", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api);
    const placed = await placer.place(anIncidentCall());

    const { placer: broke } = placerWith(api, { spent: CALLS_IN_THE_CREDIT });
    await expect(broke.get(placed.id)).resolves.toMatchObject({
      id: placed.id,
    });
  });
});

/**
 * The guard that would have stopped 2026-08-22. Twenty-three separate call tasks were created in
 * half an hour, every one of them a different logical call and so every one of them fine by any
 * check that looks at a single call. What was wrong was the rate.
 */
describe("how fast this build may call", () => {
  it("refuses once too many have gone out in the window, and sends nothing", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, {
      recent: MAX_CALLS_PER_BURST_WINDOW,
    });

    await expect(placer.place(anIncidentCall())).rejects.toThrow(
      CallBurstError,
    );
    expect(api.creates).toHaveLength(0);
  });

  it("allows the last one inside the window", async () => {
    const api = calleApiStub();
    const { placer } = placerWith(api, {
      recent: MAX_CALLS_PER_BURST_WINDOW - 1,
    });

    await expect(placer.place(anIncidentCall())).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("reads the window from the clock rather than from all of history", async () => {
    const api = calleApiStub();
    const asked: string[] = [];
    const placer = new LiveCallPlacer({
      apiKey: API_KEY,
      budget: {
        creditUsd: CREDIT_USD,
        spent: async () => 0,
        placedSince: async (iso) => {
          asked.push(iso);
          return 0;
        },
      },
      allowedNumbers: [OWNED_NUMBER],
      locale: "en-GB",
      region: "NL",
      baseUrl: "https://calle.invalid",
      fetchImpl: api.fetch,
      now: () => new Date("2026-08-22T12:30:00.000Z"),
    });

    await placer.place(anIncidentCall());
    expect(asked[0]).toBe("2026-08-22T12:20:00.000Z");
  });
});
