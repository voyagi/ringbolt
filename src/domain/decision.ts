import { z } from "zod";
import type { ActionParameter, ParameterValue } from "../actions/definition.js";
import { readParameters } from "../actions/parameters.js";

/**
 * The shape Ringbolt asks CALL-E to extract from the conversation. It is sent as the call's
 * `resultSchema` so the spoken answer comes back validated rather than as prose we have to guess at.
 */
export const decisionResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: {
      type: "string",
      enum: ["run_action", "hold", "escalate", "snooze"],
      description:
        "What the responder decided. run_action means carry out one of the offered actions. hold means change nothing. escalate means hand this to someone else. snooze means leave it and call back later.",
    },
    action_id: {
      type: "string",
      description:
        "The id of the action to run. Required when decision is run_action. Must be one of the action ids read out on the call.",
    },
    confirmation_phrase: {
      type: "string",
      description:
        "The exact confirmation phrase the responder said out loud. Required for any action marked as needing confirmation.",
    },
    action_parameters: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Any values the chosen action asked for, keyed by the parameter name that was read out. Leave a value out rather than guessing at it.",
    },
    snooze_minutes: {
      type: "number",
      description:
        "How long to wait before calling back. Only when decision is snooze.",
    },
    reason: {
      type: "string",
      description: "The responder's own words for why they decided this.",
    },
  },
} as const;

export const decisionKinds = [
  "run_action",
  "hold",
  "escalate",
  "snooze",
] as const;
export type DecisionKind = (typeof decisionKinds)[number];

export const spokenDecision = z.object({
  decision: z.enum(decisionKinds),
  action_id: z.string().min(1).optional(),
  confirmation_phrase: z.string().optional(),
  action_parameters: z.record(z.string(), z.unknown()).optional(),
  snooze_minutes: z
    .number()
    .finite()
    .positive()
    .max(24 * 60)
    .optional(),
  reason: z.string().optional(),
});

export type SpokenDecision = z.infer<typeof spokenDecision>;

export const CONFIDENCE_FLOOR = 0.7;

/**
 * Enough of an action for the gate to decide on it: what it is called, what must be said before it
 * runs, what values it takes, and whether it wants more certainty than the product-wide floor.
 */
export type OfferedActionLike = {
  id: string;
  confirmationPhrase?: string | null;
  parameters?: readonly ActionParameter[];
  minConfidence?: number | null;
};

export type AuthorizationInput<TAction extends OfferedActionLike> = {
  callStatus: string;
  taskCompleted: boolean | null;
  confidenceScore: number | null;
  structuredResult: unknown;
  /**
   * What was said on the call. Taken as the plain shape rather than the adapter's type, like
   * callStatus above, so the gate stays a pure function of what a call reported.
   */
  transcript: readonly { speaker: string; text: string }[];
  /**
   * The actions that were read out on this call. Authorization returns the matching member of this
   * array rather than an id, so the set that permits an action and the set that supplies the one
   * that runs are the same objects. A separate lookup afterwards is how a per-service policy grows
   * a hole: the check narrows and the lookup does not.
   */
  offered: readonly TAction[];
};

export type Authorization<TAction extends OfferedActionLike> =
  | {
      authorized: true;
      decision: SpokenDecision;
      action: TAction;
      /** What the responder said the action should be given, checked against what it declared. */
      parameters: Record<string, ParameterValue>;
    }
  | {
      authorized: false;
      refusal: RefusalReason;
      detail: string;
      decision?: SpokenDecision;
    };

export type Refusal<TAction extends OfferedActionLike> = Extract<
  Authorization<TAction>,
  { authorized: false }
>;

export type RefusalReason =
  | "call_not_completed"
  | "task_not_completed"
  | "responder_not_heard"
  | "confidence_below_floor"
  | "result_not_schema_valid"
  | "not_an_action_decision"
  | "action_not_offered"
  | "confidence_below_action_floor"
  | "confirmation_missing"
  | "confirmation_mismatch"
  | "parameters_invalid";

/**
 * Every refusal here is a decision NOT to touch production. The order matters: cheaper and more
 * fundamental checks run first so the detail message names the earliest thing that was wrong,
 * which is the one worth showing a human.
 */
export function authorize<TAction extends OfferedActionLike>(
  input: AuthorizationInput<TAction>,
): Authorization<TAction> {
  if (input.callStatus !== "completed") {
    return {
      authorized: false,
      refusal: "call_not_completed",
      detail: `call status was ${input.callStatus}`,
    };
  }

  if (input.taskCompleted !== true) {
    return {
      authorized: false,
      refusal: "task_not_completed",
      detail: "the call ended without the task being completed",
    };
  }

  if (!responderWasHeard(input.transcript)) {
    return {
      authorized: false,
      refusal: "responder_not_heard",
      detail:
        "the call completed but not one word from the person who answered was transcribed, so there is no evidence anybody authorized anything",
    };
  }

  // NaN and Infinity both fail every comparison, so a bare `score < FLOOR` lets them through into
  // the one branch whose whole job is to stop a guess. The range check is here for the same reason:
  // a number outside 0..1 did not come from the field this floor is about.
  const score = input.confidenceScore;
  if (
    score === null ||
    !Number.isFinite(score) ||
    score < CONFIDENCE_FLOOR ||
    score > 1
  ) {
    return {
      authorized: false,
      refusal: "confidence_below_floor",
      detail: `confidence ${score ?? "unknown"} is not a number at or above the floor of ${CONFIDENCE_FLOOR}`,
    };
  }

  const parsed = spokenDecision.safeParse(input.structuredResult);
  if (!parsed.success) {
    return {
      authorized: false,
      refusal: "result_not_schema_valid",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; "),
    };
  }

  const decision = parsed.data;
  if (decision.decision !== "run_action") {
    return {
      authorized: false,
      refusal: "not_an_action_decision",
      detail: `responder chose to ${decision.decision}`,
      decision,
    };
  }

  const actionId = decision.action_id;
  const action = input.offered.find((candidate) => candidate.id === actionId);
  if (actionId === undefined || action === undefined) {
    return {
      authorized: false,
      refusal: "action_not_offered",
      detail: `${actionId ?? "no action"} was not among the actions offered on this call`,
      decision,
    };
  }

  // An action may ask for more certainty than the product-wide floor. The floor above is about the
  // call; this one is about what is being authorized, so a destructive action can hold out for a
  // clearer one without raising the bar for turning a feature off.
  const ownFloor = action.minConfidence;
  if (ownFloor !== undefined && ownFloor !== null && score < ownFloor) {
    return {
      authorized: false,
      refusal: "confidence_below_action_floor",
      detail: `${actionId} needs a confidence of at least ${ownFloor} and this call scored ${score}`,
      decision,
    };
  }

  const confirmation = checkConfirmation(action, decision, actionId);
  if (confirmation !== null) return confirmation;

  const read = readParameters(
    action.parameters ?? [],
    decision.action_parameters,
  );
  if (!read.ok) {
    return {
      authorized: false,
      refusal: "parameters_invalid",
      detail: read.problem,
      decision,
    };
  }

  return { authorized: true, decision, action, parameters: read.values };
}

/**
 * Whether the person on the other end said anything the call actually captured.
 *
 * Every one of the 23 attempts made on 2026-08-22 came back with the responder's turns present and
 * empty: no text, no duration. A call in that state can still report the task completed with high
 * confidence and a schema-valid decision in it, and every other check in this function would pass
 * it, so a production change would run on a conversation that only one side of took part in.
 *
 * A `bot` turn does not count, and neither does `unknown`: the point is evidence that the human was
 * heard, and an unattributed turn is the machine's own guess about who was speaking. Refusing here
 * escalates rather than acts, which on a channel this broken means a person is telephoned about it.
 */
function responderWasHeard(
  transcript: readonly { speaker: string; text: string }[],
): boolean {
  return transcript.some(
    (turn) => turn.speaker === "user" && turn.text.trim() !== "",
  );
}

function checkConfirmation<TAction extends OfferedActionLike>(
  action: TAction,
  decision: SpokenDecision,
  actionId: string,
): Refusal<TAction> | null {
  const required = action.confirmationPhrase;
  if (required === undefined || required === null) return null;

  const spoken = decision.confirmation_phrase;
  if (spoken === undefined || spoken.trim() === "") {
    return {
      authorized: false,
      refusal: "confirmation_missing",
      detail: `${actionId} needs the spoken phrase "${required}"`,
      decision,
    };
  }
  if (!phrasesMatch(spoken, required)) {
    return {
      authorized: false,
      refusal: "confirmation_mismatch",
      detail: `heard "${spoken}" but this action needs "${required}"`,
      decision,
    };
  }
  return null;
}

/**
 * Speech to text does not preserve punctuation, casing, or filler, so an exact string compare would
 * refuse phrases a person plainly said. Normalising to words is as loose as this is allowed to get:
 * the words themselves, in order, still have to be right.
 */
function phrasesMatch(spoken: string, required: string): boolean {
  return normalisePhrase(spoken) === normalisePhrase(required);
}

function normalisePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ");
}
