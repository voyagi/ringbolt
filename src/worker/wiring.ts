import {
  D1FakeCallStore,
  FakeCallPlacer,
  type FakeScenario,
  type FakeScenarioKind,
} from "../calle/fake.js";
import { LiveCallPlacer } from "../calle/live.js";
import type { CallPlacer, PlaceCallInput, Scheduler } from "../calle/port.js";
import { Repo } from "../db/repo.js";
import type { Exclusive, WakeScheduler } from "../domain/orchestrator.js";
import { Orchestrator } from "../domain/orchestrator.js";
import {
  type Bindings,
  type RingboltConfig,
  allowedLiveNumbers,
} from "./env.js";

/**
 * Dialled when nothing has been configured and no rotation exists. It fails the E.164 check live
 * mode's number has to pass, so it cannot become a real call.
 */
const UNCONFIGURED_RESPONDER = "+00000000000";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function waitUntilScheduler(ctx: {
  waitUntil: (promise: Promise<unknown>) => void;
}): Scheduler {
  return (delayMs, run) => {
    ctx.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(run),
    );
  };
}

/** Runs the deferred work immediately, for tests that want the whole loop inside one await. */
export const immediateScheduler: Scheduler = (_delayMs, run) => {
  void run();
};

/**
 * For a caller that drives the orchestrator without a Durable Object behind it, which in practice
 * means a test. Nothing schedules an alarm, so nothing parked ever wakes up on its own: a test
 * using this is responsible for calling wake() itself. The product never uses it, which is why
 * buildOrchestrator demands a wake scheduler rather than quietly defaulting to this one.
 */
export const unscheduledWakes: WakeScheduler = {
  schedule: async () => undefined,
  clear: async () => undefined,
};

/** What the stand-in does on a call, chosen by configuration rather than by the code path. */
function scenarioOf(kind: FakeScenarioKind, afterMs: number): FakeScenario {
  if (kind !== "answers") return { kind, afterMs };
  return {
    kind: "answers",
    afterMs,
    decision: {
      decision: "run_action",
      action_id: "kill_switch",
      reason: "Turn it off while we look at it.",
    },
  };
}

export type PlacerOptions = {
  scheduler: Scheduler;
  now?: () => Date;
  scenarioFor?: (input: PlaceCallInput) => FakeScenario;
  /**
   * The transport the CALL-E adapter sends through. Left out in the product, where the platform's
   * own fetch is the right answer. Supplying one is how the whole incident loop is run against the
   * real adapter without a telephone ringing, which is the only way that path gets exercised more
   * than the handful of times the call allowance can pay for.
   */
  calleFetch?: (input: Request) => Promise<Response>;
};

export type OrchestratorOptions = PlacerOptions & {
  /** Dialled when no rotation has been configured. Live mode uses the configured number. */
  responderPhone?: string;
  /**
   * Required rather than defaulted, because a default would be an unserialised one and the caller
   * that most needs the section is the one least likely to notice it is missing.
   */
  exclusive: Exclusive;
  /**
   * Required for the same reason: a default that quietly did nothing would leave every parked
   * incident waiting for a timer nobody set.
   */
  wake: WakeScheduler;
};

export function buildPlacer(
  env: Bindings,
  config: RingboltConfig,
  options: PlacerOptions,
): CallPlacer {
  const now = options.now ?? (() => new Date());

  if (config.CALLE_MODE === "live") {
    return new LiveCallPlacer({
      apiKey: config.CALLE_API_KEY,
      // The ledger is what the product reports at /api/budget, so the ceiling and the published
      // figure are the same count rather than two that can disagree.
      budget: { spent: () => new Repo(env.DB).countRealCalls() },
      allowedNumbers: allowedLiveNumbers(config),
      ...(options.calleFetch === undefined
        ? {}
        : { fetchImpl: options.calleFetch }),
    });
  }

  return new FakeCallPlacer({
    store: new D1FakeCallStore(env.DB, now),
    scheduler: options.scheduler,
    scenarioFor:
      options.scenarioFor ??
      (() =>
        scenarioOf(config.CALLE_FAKE_SCENARIO, config.CALLE_FAKE_DELAY_MS)),
    now,
  });
}

/**
 * The stand-in never carries the real number. It cannot dial, so a number in its records would be
 * personal data kept for nothing, and a mode that got mixed up could not turn a test into a call.
 */
function responderFor(
  config: RingboltConfig,
  override: string | undefined,
): string {
  if (config.CALLE_MODE === "live") return config.DEMO_PHONE;
  return override ?? UNCONFIGURED_RESPONDER;
}

export function buildOrchestrator(
  env: Bindings,
  config: RingboltConfig,
  options: OrchestratorOptions,
): Orchestrator {
  const now = options.now ?? (() => new Date());
  return new Orchestrator({
    repo: new Repo(env.DB),
    placer: buildPlacer(env, config, options),
    publicBaseUrl: config.PUBLIC_BASE_URL,
    fallbackPhone: responderFor(config, options.responderPhone),
    now,
    newId,
    exclusive: options.exclusive,
    wake: options.wake,
  });
}
