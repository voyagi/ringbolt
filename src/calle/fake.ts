import type {
  CallPlacer,
  CallSnapshot,
  PlaceCallInput,
  Scheduler,
  TranscriptTurn,
} from "./port.js";

/**
 * The outcomes the stand-in can rehearse. Named here rather than only in the union below because
 * the configuration picks one by name, which is how the escalation and refusal paths are exercised
 * without spending a real call on each of them.
 */
export const fakeScenarioKinds = [
  "answers",
  "no_answer",
  "hangs_up",
  "unparseable",
  "one_way_audio",
] as const;

export type FakeScenarioKind = (typeof fakeScenarioKinds)[number];

export type FakeScenario =
  | {
      kind: "answers";
      decision: Record<string, unknown>;
      confidence?: number;
      afterMs?: number;
      /**
       * What the responder is heard saying, when the caller wants a particular conversation rather
       * than the shortest one that reaches the gate. The demo is the case that needs it: the deck
       * draws a line from the sentence that granted permission to the action it allowed, and it
       * draws it only where the words the action actually required are present.
       */
      turns?: readonly TranscriptTurn[];
    }
  | { kind: "no_answer"; afterMs?: number }
  | { kind: "hangs_up"; afterMs?: number }
  | { kind: "unparseable"; afterMs?: number }
  | {
      kind: "one_way_audio";
      decision: Record<string, unknown>;
      confidence?: number;
      afterMs?: number;
    };

/**
 * The fake keeps its calls somewhere both the caller and the webhook receiver can read, because
 * those two run in different isolates on Workers. An in-memory map would make the fake pass a test
 * the real integration would fail.
 */
export interface FakeCallStore {
  get(id: string): Promise<CallSnapshot | null>;
  findByIdempotencyKey(key: string): Promise<CallSnapshot | null>;
  put(key: string, snapshot: CallSnapshot): Promise<void>;
}

export class MemoryFakeCallStore implements FakeCallStore {
  private readonly byId = new Map<string, CallSnapshot>();
  private readonly byKey = new Map<string, string>();

  async get(id: string): Promise<CallSnapshot | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<CallSnapshot | null> {
    const id = this.byKey.get(key);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async put(key: string, snapshot: CallSnapshot): Promise<void> {
    this.byId.set(snapshot.id, snapshot);
    this.byKey.set(key, snapshot.id);
  }
}

export class D1FakeCallStore implements FakeCallStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date,
  ) {}

  async get(id: string): Promise<CallSnapshot | null> {
    const row = await this.db
      .prepare(`SELECT snapshot FROM fake_calls WHERE id = ?1`)
      .bind(id)
      .first<{ snapshot: string }>();
    return row === null ? null : (JSON.parse(row.snapshot) as CallSnapshot);
  }

  async findByIdempotencyKey(key: string): Promise<CallSnapshot | null> {
    const row = await this.db
      .prepare(`SELECT snapshot FROM fake_calls WHERE idempotency_key = ?1`)
      .bind(key)
      .first<{ snapshot: string }>();
    return row === null ? null : (JSON.parse(row.snapshot) as CallSnapshot);
  }

  async put(key: string, snapshot: CallSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fake_calls (id, idempotency_key, snapshot, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
      )
      .bind(
        snapshot.id,
        key,
        JSON.stringify(snapshot),
        this.now().toISOString(),
      )
      .run();
  }
}

/**
 * A call that reached somebody and came back with a decision in it. The two scenarios that produce
 * one are identical apart from the transcript, which is the entire point of the second: everything
 * a gate can check looks the same, and only the record of who spoke says they are different calls.
 */
function decided(
  confidence: number,
  decision: Record<string, unknown>,
): Pick<
  CallSnapshot,
  | "status"
  | "taskCompleted"
  | "confidenceScore"
  | "confidenceLabel"
  | "structuredResult"
  | "summary"
  | "evidence"
> {
  return {
    status: "completed",
    taskCompleted: true,
    confidenceScore: confidence,
    confidenceLabel: confidence >= 0.8 ? "high" : "medium",
    structuredResult: decision,
    summary: "The responder was reached and gave a decision.",
    evidence: ["responder confirmed the decision out loud"],
  };
}

/** What the caller is heard saying. Bounded, because a transcript turn is a line, not a script. */
function opening(input: PlaceCallInput): string {
  return input.task.slice(0, 200);
}

export type FakeOptions = {
  store: FakeCallStore;
  scheduler: Scheduler;
  scenarioFor: (input: PlaceCallInput) => FakeScenario;
  now?: () => Date;
  newId?: () => string;
  /** Injected so a test can read the delivery the fake sends without needing a live loopback. */
  fetchImpl?: typeof fetch;
};

/**
 * A stand-in for CALL-E that keeps the parts that make the real thing hard: the call is
 * asynchronous, the outcome arrives by unsigned webhook carrying almost nothing, and the real state
 * has to be fetched back. It is deliberately unhelpful rather than convenient, so that code which
 * passes against it also passes against the real API.
 */
export class FakeCallPlacer implements CallPlacer {
  readonly kind = "fake" as const;

  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: FakeOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `call_fake_${crypto.randomUUID()}`);
  }

  async place(input: PlaceCallInput): Promise<CallSnapshot> {
    const existing = await this.options.store.findByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing !== null) return existing;

    const queued: CallSnapshot = {
      id: this.newId(),
      status: "queued",
      taskCompleted: null,
      confidenceScore: null,
      confidenceLabel: null,
      structuredResult: null,
      summary: null,
      evidence: [],
      transcript: [],
      metadata: input.metadata,
      failureCode: null,
    };
    await this.options.store.put(input.idempotencyKey, queued);

    const scenario = this.options.scenarioFor(input);
    this.options.scheduler(scenario.afterMs ?? 1200, async () => {
      const terminal = this.resolve(queued.id, scenario, input);
      await this.options.store.put(input.idempotencyKey, terminal);
      await this.deliver(input.webhookUrl, terminal);
    });

    return queued;
  }

  async get(callId: string): Promise<CallSnapshot> {
    const call = await this.options.store.get(callId);
    if (call === null) throw new Error(`unknown call ${callId}`);
    return call;
  }

  private resolve(
    id: string,
    scenario: FakeScenario,
    input: PlaceCallInput,
  ): CallSnapshot {
    const base = {
      id,
      metadata: input.metadata,
      failureCode: null as string | null,
      evidence: [] as string[],
      transcript: [] as CallSnapshot["transcript"],
    };

    switch (scenario.kind) {
      case "answers":
        return {
          ...base,
          ...decided(scenario.confidence ?? 0.92, scenario.decision),
          transcript: [
            { offsetSeconds: 0, speaker: "bot", text: opening(input) },
            ...(scenario.turns ?? [
              {
                offsetSeconds: 9,
                speaker: "user",
                text: "Understood. Go ahead.",
              },
            ]),
          ],
        };
      case "no_answer":
        return {
          ...base,
          status: "failed",
          taskCompleted: false,
          confidenceScore: null,
          confidenceLabel: null,
          structuredResult: null,
          summary: "Nobody picked up.",
          failureCode: "no_answer",
        };
      case "hangs_up":
        return {
          ...base,
          status: "completed",
          taskCompleted: false,
          confidenceScore: 0.2,
          confidenceLabel: "low",
          structuredResult: null,
          summary:
            "The call connected but ended before a decision was reached.",
        };
      case "unparseable":
        return {
          ...base,
          status: "completed",
          taskCompleted: true,
          confidenceScore: 0.95,
          confidenceLabel: "high",
          structuredResult: { decision: "do the thing", whatever: true },
          summary:
            "A decision was reached but it did not match the requested shape.",
        };
      /**
       * The call the product has actually made 23 times and never once completed: Ringbolt talks,
       * the transcript carries the responder's turns with no text and no duration, and nothing the
       * person said is anywhere in the record.
       *
       * The transcript half is what was observed. The rest is deliberately the most dangerous shape
       * it could be paired with: task completed, high confidence, and a schema-valid decision to
       * change production. A guard is worth having only if it holds when everything else looks
       * right, and this is the pairing that says whether it does.
       */
      case "one_way_audio":
        return {
          ...base,
          ...decided(scenario.confidence ?? 0.94, scenario.decision),
          transcript: [
            { offsetSeconds: 0, speaker: "bot", text: opening(input) },
            { offsetSeconds: 0, speaker: "user", text: "" },
            { offsetSeconds: 0, speaker: "bot", text: "Are you still there?" },
            { offsetSeconds: 0, speaker: "user", text: "" },
          ],
        };
    }
  }

  private async deliver(webhookUrl: string, call: CallSnapshot): Promise<void> {
    const event = {
      id: `evt_fake_${crypto.randomUUID()}`,
      type: call.status === "completed" ? "call.completed" : "call.failed",
      created_at: this.now().toISOString(),
      data: { id: call.id, status: call.status, metadata: call.metadata },
    };

    const send = this.options.fetchImpl ?? fetch;
    try {
      await send(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CALL-E-Event-Id": event.id,
        },
        body: JSON.stringify(event),
      });
    } catch {
      // The real CALL-E retries a delivery that does not land, and the terminal snapshot is already
      // stored by this point, so the call is readable whether or not the webhook ever arrives.
      // Swallowing it here is what lets a test exercise the recovery path in src/worker/reconcile.ts,
      // which re-reads any incident left waiting on a call and finishes it.
    }
  }
}
