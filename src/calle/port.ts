export type JsonObject = Record<string, unknown>;

export type CallStatus =
  "queued" | "in_progress" | "completed" | "failed" | "canceled";

/**
 * Whether a call is over. Every path that acts on a call reads this one function: a call that is
 * still running has no decision in it yet, and treating it as though it did spends the incident's
 * one move out of `calling` on nothing, which then discards the decision the responder is at that
 * moment still giving.
 */
export function isTerminalCall(status: CallStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export type TranscriptTurn = {
  offsetSeconds: number | null;
  speaker: "bot" | "user" | "unknown";
  text: string;
};

export type PlaceCallInput = {
  phone: string;
  task: string;
  resultSchema: JsonObject;
  metadata: Record<string, string>;
  webhookUrl: string;
  /** Sent to CALL-E so a retried create cannot become a second phone call to a real person. */
  idempotencyKey: string;
};

export type CallSnapshot = {
  id: string;
  status: CallStatus;
  taskCompleted: boolean | null;
  confidenceScore: number | null;
  confidenceLabel: string | null;
  structuredResult: unknown;
  summary: string | null;
  evidence: string[];
  transcript: TranscriptTurn[];
  metadata: JsonObject;
  failureCode: string | null;
  /**
   * The sentence CALL-E writes beside the code, when it writes one. On 2026-09-08 a task failed
   * before dialling with the code `call_not_ready`, and the sentence that explained it ("Calls to
   * the Netherlands in English are not supported for this call setup") sat unread in the API
   * response while the record said "The call ended." Optional so that a snapshot built by a test
   * or an older store still reads; the two placers always fill it in.
   */
  failureMessage?: string | null;
};

/**
 * The only way Ringbolt reaches a telephone. One implementation exists today, the local stand-in,
 * and `test/placer-contract.test.ts` is the suite any second one has to satisfy: it is written
 * against this interface rather than against the stand-in, so the CALL-E adapter is added to it by
 * naming a second implementation. Development runs on the stand-in because the real-call budget is
 * small and every real call reaches an actual phone.
 */
export interface CallPlacer {
  place(input: PlaceCallInput): Promise<CallSnapshot>;
  /**
   * Authoritative read. A webhook is never trusted on its own, so this is what decides whether an
   * action may run.
   */
  get(callId: string): Promise<CallSnapshot>;
  readonly kind: "live" | "fake";
}

/** Deferred work, injected so the fake can be driven synchronously in tests. */
export type Scheduler = (delayMs: number, run: () => Promise<void>) => void;

/**
 * What creating one call task costs. It is money and not a quota: CALL-E bills per task created,
 * confirmed by their support on 2026-08-24, and a task that never connects is billed like any
 * other. The figure lives here rather than beside the endpoint that reports it, so the ceiling the
 * adapter refuses at and the figure the product shows can never drift apart.
 */
export const CALL_PRICE_USD = 0.05;

/**
 * How many real calls may be created inside one window, whatever the balance says.
 *
 * This is the guard that would have stopped 2026-08-22. The credit ceiling is about the total; this
 * is about the rate, and the failure that empties an account is always a rate. Twenty-three
 * separate call tasks were created in half an hour that day, each one a different logical call and
 * so each one perfectly legitimate as far as any per-call check could tell.
 */
export const BURST_WINDOW_MINUTES = 10;
export const MAX_CALLS_PER_BURST_WINDOW = 3;

/**
 * An error raised before anything was sent, so no call exists and no money was spent. It is a
 * separate type because the distinction is not cosmetic: a failure that is NOT one of these may
 * have created a call anyway, and the two cases are handled differently by the code that placed it.
 */
export class CallNotAttemptedError extends Error {}

/** What this build may spend, and what it has spent. Read immediately before a live call. */
export type CallBudget = {
  /** The credit an operator has said this deployment may use, in dollars. */
  creditUsd: number;
  spent(): Promise<number>;
  /** How many real calls were placed since a moment, which is what bounds a burst. */
  placedSince(iso: string): Promise<number>;
};

/** Rounded to cents, because a sum of prices in binary floating point is not a price. */
export function usd(amount: number): number {
  return Math.round(amount * 100) / 100;
}
