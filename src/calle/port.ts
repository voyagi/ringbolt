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
 * The CALL-E free tier is twenty calls in total and there is no way to buy a twenty first. The
 * number lives here rather than beside the endpoint that reports it, so the ceiling the live
 * adapter refuses at and the figure the product shows can never drift apart.
 */
export const REAL_CALL_ALLOWANCE = 20;

/** How many real calls have already been spent. Read immediately before a live call is placed. */
export type CallBudget = {
  spent(): Promise<number>;
};
