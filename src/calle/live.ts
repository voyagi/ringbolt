import { type Call, CalleClient, type CalleClientOptions } from "@call-e/calle";
import {
  type CallBudget,
  type CallPlacer,
  type CallSnapshot,
  type PlaceCallInput,
  REAL_CALL_ALLOWANCE,
  type TranscriptTurn,
} from "./port.js";

/** The SDK hands its transport an already built Request, which is what lets a test drive it. */
type CalleFetch = (input: Request) => Promise<Response>;

export type LiveOptions = {
  apiKey: string;
  budget: CallBudget;
  /**
   * Every number this adapter may dial. Required rather than optional: the rotation can name any
   * contact anybody added, so the list of telephones a live build can reach has to be something an
   * operator wrote down, and a caller that forgot to supply one should not compile.
   */
  allowedNumbers: readonly string[];
  /** The CALL-E API host. Defaults to the SDK's own, which is the production one. */
  baseUrl?: string;
  fetchImpl?: CalleFetch;
};

export class CallBudgetExhaustedError extends Error {
  constructor(readonly spent: number) {
    super(
      `${spent} of the ${REAL_CALL_ALLOWANCE} real calls are already spent, so no call was placed`,
    );
    this.name = "CallBudgetExhaustedError";
  }
}

export class NumberNotAllowedError extends Error {
  constructor() {
    // Deliberately does not repeat the number. This message reaches an audit record and an HTTP
    // response, and a rejected number is still somebody's telephone number.
    super(
      "that number is not on this build's list of numbers it may call, so no call was placed",
    );
    this.name = "NumberNotAllowedError";
  }
}

/**
 * The real telephone. It satisfies the same contract as the local stand-in and is held to it by the
 * same suite, which is the only way to know that code proven against the stand-in still holds here.
 */
export class LiveCallPlacer implements CallPlacer {
  readonly kind = "live" as const;

  private readonly calle: CalleClient;
  private readonly budget: CallBudget;
  private readonly allowedNumbers: ReadonlySet<string>;

  constructor(options: LiveOptions) {
    const clientOptions: CalleClientOptions = { apiKey: options.apiKey };
    if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
    if (options.fetchImpl !== undefined)
      clientOptions.fetch = options.fetchImpl;

    this.calle = new CalleClient(clientOptions);
    this.budget = options.budget;
    this.allowedNumbers = new Set(options.allowedNumbers);
  }

  /**
   * Both guards are here rather than at any one caller, because this is the line that rings a real
   * telephone and spends an allowance that cannot be topped up, and a caller added later would not
   * know to ask.
   *
   * The number is checked first: a call to somebody who never agreed to be called is worse than a
   * call one over budget, and refusing it costs nothing. The allowance is a ceiling and not a lock,
   * since the ledger is written after CALL-E accepts, so placements still in flight are not counted
   * yet and a simultaneous burst can overshoot by however many are in the air. It is aimed at the
   * failure that would actually empty the allowance, which is a loop retrying, and that one is
   * serial.
   */
  async place(input: PlaceCallInput): Promise<CallSnapshot> {
    if (!this.allowedNumbers.has(input.phone))
      throw new NumberNotAllowedError();

    const spent = await this.budget.spent();
    if (spent >= REAL_CALL_ALLOWANCE) throw new CallBudgetExhaustedError(spent);

    const call = await this.calle.calls.create(
      {
        task: input.task,
        recipient: { phone: input.phone },
        resultSchema: input.resultSchema,
        metadata: input.metadata,
        webhookUrl: input.webhookUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );

    return toSnapshot(call);
  }

  /**
   * Deliberately outside the allowance check. Reading a call costs nothing, and an incident whose
   * call cannot be read is an incident that never resolves, so a spent allowance must not be able
   * to strand the calls it already paid for.
   */
  async get(callId: string): Promise<CallSnapshot> {
    return toSnapshot(await this.calle.calls.get(callId));
  }
}

function toSnapshot(call: Call): CallSnapshot {
  return {
    id: call.id,
    status: call.status,
    taskCompleted: call.taskCompleted,
    confidenceScore: call.completionConfidence?.score ?? null,
    confidenceLabel: call.completionConfidence?.label ?? null,
    structuredResult: call.structuredResult,
    summary: call.summary,
    evidence: call.evidence,
    transcript: transcriptOf(call),
    failureCode: call.failureCode ?? attemptFailureCode(call),
    metadata: call.metadata,
  };
}

/**
 * The SDK renames the fields it owns but leaves each transcript turn exactly as the API sent it, so
 * a turn read straight from it carries offset_seconds and no offsetSeconds. Source order is kept
 * rather than sorted on that offset, which the API documents as null whenever a line arrived with
 * no parseable timestamp.
 */
function transcriptOf(call: Call): TranscriptTurn[] {
  return call.recipients.flatMap((recipient) =>
    recipient.attempts.flatMap((attempt) =>
      attempt.transcriptTurns.map((turn) => ({
        offsetSeconds: turn.offset_seconds,
        speaker: turn.speaker,
        text: turn.text,
      })),
    ),
  );
}

/**
 * A task-level failure code is set only when the whole task failed, while the reason one telephone
 * did not answer sits on the attempt. Phase 3 decides who to try next from this field, so the most
 * recent attempt's reason is carried up rather than reported as no reason at all.
 */
function attemptFailureCode(call: Call): string | null {
  const codes = call.recipients
    .flatMap((recipient) => recipient.attempts)
    .map((attempt) => attempt.failureCode)
    .filter((code): code is string => code !== null);

  return codes.at(-1) ?? null;
}
