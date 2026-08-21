export type JsonObject = Record<string, unknown>;

export type CallStatus =
  "queued" | "in_progress" | "completed" | "failed" | "canceled";

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
 * The only way Ringbolt reaches a telephone. Two implementations exist and both are held to the
 * same contract tests: one talks to CALL-E, one is a local fake. Development runs on the fake
 * because the real-call budget is small and every real call reaches an actual phone.
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
