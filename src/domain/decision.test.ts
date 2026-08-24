import { describe, expect, it } from "vitest";
import type { ActionParameter } from "../actions/definition.js";
import {
  CONFIDENCE_FLOOR,
  type AuthorizationInput,
  authorize,
} from "./decision.js";

const offered = [
  { id: "kill_switch" },
  { id: "rollback", confirmationPhrase: "roll it back" },
];

/** A call where the person answered and was heard. Every case below varies one thing from it. */
const heard = [
  {
    speaker: "bot",
    text: "This is Ringbolt, an automated system, calling about checkout.",
  },
  { speaker: "user", text: "Right. Turn it off." },
];

const base: AuthorizationInput<(typeof offered)[number]> = {
  callStatus: "completed",
  taskCompleted: true,
  confidenceScore: 0.95,
  structuredResult: { decision: "run_action", action_id: "kill_switch" },
  transcript: heard,
  offered,
};

describe("authorize", () => {
  it("lets a clean decision through", () => {
    const result = authorize(base);
    expect(result).toMatchObject({
      authorized: true,
      action: { id: "kill_switch" },
    });
  });

  it("returns the offered action itself, not a name to look up again", () => {
    const result = authorize(base);
    expect(result.authorized && result.action).toBe(offered[0]);
  });

  it("refuses a call that did not complete", () => {
    const result = authorize({ ...base, callStatus: "failed" });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "call_not_completed",
    });
  });

  it("refuses when the task itself was not completed", () => {
    const result = authorize({ ...base, taskCompleted: false });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "task_not_completed",
    });
  });

  /**
   * The shape all 23 real attempts came back in: Ringbolt talking, the responder's turns present
   * and empty. Everything else about the call looks perfect, which is the point.
   */
  it("refuses when nothing the responder said was transcribed", () => {
    const result = authorize({
      ...base,
      transcript: [
        { speaker: "bot", text: "This is Ringbolt, calling about checkout." },
        { speaker: "user", text: "" },
        { speaker: "bot", text: "Are you still there?" },
        { speaker: "user", text: "   " },
      ],
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "responder_not_heard",
    });
  });

  it("refuses a call with no transcript at all", () => {
    expect(authorize({ ...base, transcript: [] })).toMatchObject({
      authorized: false,
      refusal: "responder_not_heard",
    });
  });

  /**
   * `unknown` is the provider's own uncertainty about who was speaking. Counting it would let a
   * call where only Ringbolt was audible authorize a production change on an attribution guess.
   */
  it("does not count a turn nobody could attribute to the responder", () => {
    expect(
      authorize({
        ...base,
        transcript: [
          { speaker: "bot", text: "Calling about checkout." },
          { speaker: "unknown", text: "Yes go ahead." },
        ],
      }),
    ).toMatchObject({ authorized: false, refusal: "responder_not_heard" });
  });

  it("is satisfied by one real thing the responder said", () => {
    expect(
      authorize({
        ...base,
        transcript: [
          { speaker: "user", text: "" },
          { speaker: "user", text: "Kill it." },
        ],
      }),
    ).toMatchObject({ authorized: true });
  });

  it("refuses an unknown confidence", () => {
    const result = authorize({ ...base, confidenceScore: null });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "confidence_below_floor",
    });
  });

  it("refuses a confidence that is not a real number in range", () => {
    for (const score of [Number.NaN, Infinity, -Infinity, 1.5, -0.2]) {
      expect(authorize({ ...base, confidenceScore: score })).toMatchObject({
        authorized: false,
        refusal: "confidence_below_floor",
      });
    }
  });

  it("refuses just below the floor and allows exactly at it", () => {
    expect(
      authorize({ ...base, confidenceScore: CONFIDENCE_FLOOR - 0.001 }),
    ).toMatchObject({
      authorized: false,
      refusal: "confidence_below_floor",
    });
    expect(
      authorize({ ...base, confidenceScore: CONFIDENCE_FLOOR }),
    ).toMatchObject({ authorized: true });
  });

  it("refuses a result that does not match the requested shape", () => {
    const result = authorize({
      ...base,
      structuredResult: { decision: "do the thing" },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "result_not_schema_valid",
    });
  });

  it("refuses a null result", () => {
    const result = authorize({ ...base, structuredResult: null });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "result_not_schema_valid",
    });
  });

  it("carries a hold decision through as a refusal to act", () => {
    const result = authorize({
      ...base,
      structuredResult: { decision: "hold", reason: "leave it" },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "not_an_action_decision",
    });
  });

  it("carries escalate and snooze back so a caller can tell them apart", () => {
    const escalate = authorize({
      ...base,
      structuredResult: { decision: "escalate", reason: "not my system" },
    });
    expect(escalate).toMatchObject({
      authorized: false,
      refusal: "not_an_action_decision",
      decision: { decision: "escalate" },
    });

    const snooze = authorize({
      ...base,
      structuredResult: { decision: "snooze", snooze_minutes: 30 },
    });
    expect(snooze).toMatchObject({
      authorized: false,
      refusal: "not_an_action_decision",
      decision: { decision: "snooze", snooze_minutes: 30 },
    });
  });

  it("refuses an action that was never offered on the call", () => {
    const result = authorize({
      ...base,
      structuredResult: {
        decision: "run_action",
        action_id: "delete_database",
      },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "action_not_offered",
    });
  });

  it("refuses run_action with no action named", () => {
    const result = authorize({
      ...base,
      structuredResult: { decision: "run_action" },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "action_not_offered",
    });
  });

  it("refuses a confirmed action when nothing was said", () => {
    const result = authorize({
      ...base,
      structuredResult: { decision: "run_action", action_id: "rollback" },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "confirmation_missing",
    });
  });

  it("refuses a confirmed action when the wrong words were said", () => {
    const result = authorize({
      ...base,
      structuredResult: {
        decision: "run_action",
        action_id: "rollback",
        confirmation_phrase: "yeah do it",
      },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "confirmation_mismatch",
    });
  });

  it("accepts a confirmation that differs only in casing, punctuation and spacing", () => {
    const result = authorize({
      ...base,
      structuredResult: {
        decision: "run_action",
        action_id: "rollback",
        confirmation_phrase: "  Roll it, back. ",
      },
    });
    expect(result).toMatchObject({
      authorized: true,
      action: { id: "rollback" },
    });
  });

  it("refuses an action the caller narrowed out of the offered set", () => {
    const result = authorize({
      ...base,
      offered: [{ id: "rollback", confirmationPhrase: "roll it back" }],
      structuredResult: { decision: "run_action", action_id: "kill_switch" },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "action_not_offered",
    });
  });

  it("does not accept a confirmation that merely contains the phrase", () => {
    const result = authorize({
      ...base,
      structuredResult: {
        decision: "run_action",
        action_id: "rollback",
        confirmation_phrase: "do not roll it back yet",
      },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "confirmation_mismatch",
    });
  });

  it("names the earliest problem when several are wrong at once", () => {
    const result = authorize({
      ...base,
      callStatus: "canceled",
      taskCompleted: false,
      confidenceScore: 0.1,
      structuredResult: null,
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "call_not_completed",
    });
  });
});

const scale: ActionParameter = {
  name: "instances",
  description: "how many to run",
  type: "number",
  required: true,
  min: 1,
  max: 10,
};

const withParameters = [
  { id: "scale_out", parameters: [scale] },
  { id: "wipe", confirmationPhrase: "wipe it", minConfidence: 0.95 },
];

const spoken: AuthorizationInput<(typeof withParameters)[number]> = {
  callStatus: "completed",
  taskCompleted: true,
  confidenceScore: 0.9,
  structuredResult: {
    decision: "run_action",
    action_id: "scale_out",
    action_parameters: { instances: "6" },
  },
  transcript: heard,
  offered: withParameters,
};

describe("authorizing the values an action was given", () => {
  it("passes through what the responder said, read as the type it was declared as", () => {
    const result = authorize(spoken);
    expect(result).toMatchObject({
      authorized: true,
      parameters: { instances: 6 },
    });
  });

  it("refuses a value the action would not accept", () => {
    const result = authorize({
      ...spoken,
      structuredResult: {
        decision: "run_action",
        action_id: "scale_out",
        action_parameters: { instances: "400" },
      },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "parameters_invalid",
    });
  });

  it("refuses values for an action that asked for none", () => {
    const result = authorize({
      ...spoken,
      confidenceScore: 0.99,
      structuredResult: {
        decision: "run_action",
        action_id: "wipe",
        confirmation_phrase: "wipe it",
        action_parameters: { force: "true" },
      },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "parameters_invalid",
    });
  });

  /**
   * The product-wide floor is about whether the call went well enough to be believed. An action's
   * own floor is about what is being authorized, so a destructive one can hold out for a clearer
   * call without raising the bar for turning a feature off.
   */
  it("refuses an action that wants more certainty than this call had", () => {
    const result = authorize({
      ...spoken,
      structuredResult: {
        decision: "run_action",
        action_id: "wipe",
        confirmation_phrase: "wipe it",
      },
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: "confidence_below_action_floor",
    });

    expect(
      authorize({
        ...spoken,
        confidenceScore: 0.96,
        structuredResult: {
          decision: "run_action",
          action_id: "wipe",
          confirmation_phrase: "wipe it",
        },
      }),
    ).toMatchObject({ authorized: true });
  });
});
