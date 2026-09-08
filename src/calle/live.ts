import {
  type Call,
  CalleAPIError,
  CalleClient,
  type CalleClientOptions,
} from "@call-e/calle";
import {
  BURST_WINDOW_MINUTES,
  CALL_PRICE_USD,
  type CallBudget,
  CallNotAttemptedError,
  type CallPlacer,
  type CallSnapshot,
  MAX_CALLS_PER_BURST_WINDOW,
  type PlaceCallInput,
  type TranscriptTurn,
  usd,
} from "./port.js";
import { SchemaNotSupportedError, resultSchemaProblem } from "./schema.js";

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
  /**
   * The language the conversation will be held in, as a BCP 47 tag, and the country the telephone
   * is in. Required for the same reason as the numbers: both are optional to CALL-E, and a build
   * that leaves them out has quietly let somebody else decide what language its incident calls are
   * conducted in and which route they take. See `docs/two-way-audio.md`.
   */
  locale: string;
  region: string;
  /** The CALL-E API host. Defaults to the SDK's own, which is the production one. */
  baseUrl?: string;
  fetchImpl?: CalleFetch;
  now?: () => Date;
};

export class CallBudgetExhaustedError extends CallNotAttemptedError {
  constructor(
    readonly spent: number,
    creditUsd: number,
  ) {
    super(
      creditUsd === 0
        ? "this build has no call credit configured, so no call was placed. Set CALLE_CREDIT_USD to what you are prepared to spend"
        : `$${usd(spent * CALL_PRICE_USD)} of the $${usd(creditUsd)} credit is already spent, so no call was placed`,
    );
    this.name = "CallBudgetExhaustedError";
  }
}

/**
 * Too many calls in too short a window. It is a refusal to keep going rather than a refusal to
 * call: whatever produced this many separate calls this fast is a loop, and the cheapest correct
 * answer to a loop that spends money is to stop it and say so.
 */
export class CallBurstError extends CallNotAttemptedError {
  constructor(readonly recent: number) {
    super(
      `${recent} calls have already been placed in the last ${BURST_WINDOW_MINUTES} minutes, which is the most this build will make, so no call was placed`,
    );
    this.name = "CallBurstError";
  }
}

/**
 * CALL-E read the request, decided against it, and said so. Their own considered refusal, so no call
 * task was created, nothing was billed, and nobody's telephone is ringing.
 *
 * It is a CallNotAttemptedError for both halves of what that type means here. Nothing is re-sent: a
 * request they have already judged invalid is judged the same way the second time, and the first
 * real go-live attempt was refused with "who should the bot say is calling in the opening sentence?"
 * and re-sent for nothing. And nothing is counted as spent: reporting "a call may exist, check the
 * CALL-E dashboard" about a call they told us they did not make sends somebody looking for it.
 *
 * 408 and 429 are deliberately outside this. A request that timed out on their side, or was refused
 * for rate after being taken in, is one where "did a call task get made" is exactly the question
 * nobody can answer, and the safe reading of a maybe is that it did.
 */
export class CallRejectedError extends CallNotAttemptedError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CallRejectedError";
  }
}

/**
 * Whether CALL-E answered with a decision not to create the call, as opposed to a failure that may
 * have left one behind. Only their own 4xx counts, because that is a considered refusal with a
 * response body behind it; a timeout, a connection failure or a 5xx is a maybe, and 408 and 429 are
 * excluded for the same reason. Everything that spends money here reads a maybe as a yes.
 */
function rejectedOutright(error: unknown): error is CalleAPIError {
  return (
    error instanceof CalleAPIError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * What CALL-E said, with the part that explains it. Their top-level message can be as bare as
 * "result_schema is not supported." while the reason a person could act on sits under
 * `details.reason`, which is where the 2026-09-08 refusal kept its cause and where this adapter
 * never looked. The code rides along because it is what their documentation indexes refusals by.
 */
function refusalMessage(error: CalleAPIError): string {
  const reason = error.details["reason"];
  const explained =
    typeof reason === "string" && reason.trim() !== ""
      ? ` Their reason: ${reason.trim()}`
      : "";
  return `${error.message}${explained} (${error.code})`;
}

export class NumberNotAllowedError extends CallNotAttemptedError {
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
  private readonly locale: string;
  private readonly region: string;
  private readonly now: () => Date;

  constructor(options: LiveOptions) {
    const clientOptions: CalleClientOptions = { apiKey: options.apiKey };
    if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
    if (options.fetchImpl !== undefined)
      clientOptions.fetch = options.fetchImpl;

    this.calle = new CalleClient(clientOptions);
    this.budget = options.budget;
    this.allowedNumbers = new Set(options.allowedNumbers);
    this.locale = options.locale;
    this.region = options.region;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * All four guards are here rather than at any one caller, because this is the line that rings a
   * real telephone and spends real money, and a caller added later would not know to ask.
   *
   * The number is checked first: a call to somebody who never agreed to be called is worse than a
   * call one over budget, and refusing it costs nothing. Then the schema, which also costs nothing
   * and names the field CALL-E would have refused it on. Then the credit, then the rate.
   *
   * None of them is a lock. The ledger row is written after CALL-E accepts, so calls still in
   * flight are not counted yet and a simultaneous burst can overshoot by however many are in the
   * air. They are aimed at the failure that actually empties an account, which is something looping
   * serially, and 2026-08-22 was exactly that.
   */
  async place(input: PlaceCallInput): Promise<CallSnapshot> {
    if (!this.allowedNumbers.has(input.phone))
      throw new NumberNotAllowedError();

    const schemaProblem = resultSchemaProblem(input.resultSchema);
    if (schemaProblem !== null)
      throw new SchemaNotSupportedError(schemaProblem);

    const spent = await this.budget.spent();
    if ((spent + 1) * CALL_PRICE_USD > this.budget.creditUsd)
      throw new CallBudgetExhaustedError(spent, this.budget.creditUsd);

    const windowOpened = new Date(
      this.now().getTime() - BURST_WINDOW_MINUTES * 60_000,
    ).toISOString();
    const recent = await this.budget.placedSince(windowOpened);
    if (recent >= MAX_CALLS_PER_BURST_WINDOW) throw new CallBurstError(recent);

    try {
      const call = await this.calle.calls.create(
        {
          task: input.task,
          recipient: {
            phone: input.phone,
            locale: this.locale,
            region: this.region,
          },
          resultSchema: input.resultSchema,
          metadata: input.metadata,
          webhookUrl: input.webhookUrl,
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return toSnapshot(call);
    } catch (error) {
      // Their refusal is turned into ours here, at the line that knows what the SDK throws, so that
      // nothing further out has to know about HTTP status codes to tell a refusal from a maybe.
      if (rejectedOutright(error))
        throw new CallRejectedError(error.status, refusalMessage(error));
      throw error;
    }
  }

  /**
   * Deliberately outside every check above. Reading a call costs nothing, and an incident whose
   * call cannot be read is an incident that never resolves, so a spent balance must not be able to
   * strand the calls it already paid for.
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
    failureMessage: call.failureMessage ?? attemptFailureMessage(call),
    metadata: call.metadata,
  };
}

/** The same fallback as the code: the most recent attempt's sentence when the task has none. */
function attemptFailureMessage(call: Call): string | null {
  const messages = call.recipients
    .flatMap((recipient) => recipient.attempts)
    .map((attempt) => attempt.failureMessage)
    .filter((message): message is string => message !== null);

  return messages.at(-1) ?? null;
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
