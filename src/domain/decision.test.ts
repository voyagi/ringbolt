import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_FLOOR,
  type AuthorizationInput,
  authorize,
} from "./decision.js";

const offered = [
  { id: "kill_switch" },
  { id: "rollback", confirmationPhrase: "roll it back" },
];

const base: AuthorizationInput<(typeof offered)[number]> = {
  callStatus: "completed",
  taskCompleted: true,
  confidenceScore: 0.95,
  structuredResult: { decision: "run_action", action_id: "kill_switch" },
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
