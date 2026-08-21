import type {
  CallPlacer,
  CallSnapshot,
  PlaceCallInput,
  Scheduler,
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
] as const;

export type FakeScenarioKind = (typeof fakeScenarioKinds)[number];

export type FakeScenario =
  | {
      kind: "answers";
      decision: Record<string, unknown>;
      confidence?: number;
      afterMs?: number;
    }
  | { kind: "no_answer"; afterMs?: number }
  | { kind: "hangs_up"; afterMs?: number }
  | { kind: "unparseable"; afterMs?: number };

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
      case "answers": {
        const confidence = scenario.confidence ?? 0.92;
        return {
          ...base,
          status: "completed",
          taskCompleted: true,
          confidenceScore: confidence,
          confidenceLabel: confidence >= 0.8 ? "high" : "medium",
          structuredResult: scenario.decision,
          summary: "The responder was reached and gave a decision.",
          evidence: ["responder confirmed the decision out loud"],
          transcript: [
            {
              offsetSeconds: 0,
              speaker: "bot",
              text: input.task.slice(0, 200),
            },
            {
              offsetSeconds: 9,
              speaker: "user",
              text: "Understood. Go ahead.",
            },
          ],
        };
      }
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
