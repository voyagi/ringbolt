import {
  D1FakeCallStore,
  FakeCallPlacer,
  type FakeScenario,
} from "../calle/fake.js";
import { LiveCallPlacer } from "../calle/live.js";
import type { CallPlacer, PlaceCallInput, Scheduler } from "../calle/port.js";
import { Repo } from "../db/repo.js";
import type { Exclusive } from "../domain/orchestrator.js";
import { Orchestrator } from "../domain/orchestrator.js";
import type { Bindings, RingboltConfig } from "./env.js";

/**
 * Until phase 3 there is one responder, and in fake mode there is no number at all. It fails the
 * E.164 check that live mode's number has to pass, so it cannot become a real call.
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

function defaultScenario(
  afterMs: number,
): (input: PlaceCallInput) => FakeScenario {
  return () => ({
    kind: "answers",
    afterMs,
    decision: {
      decision: "run_action",
      action_id: "kill_switch",
      reason: "Turn it off while we look at it.",
    },
  });
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
  /** Fake mode only. Live mode dials the configured number and nothing else. */
  responderPhone?: string;
  /**
   * Required rather than defaulted, because a default would be an unserialised one and the caller
   * that most needs the section is the one least likely to notice it is missing.
   */
  exclusive: Exclusive;
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
      ...(options.calleFetch === undefined
        ? {}
        : { fetchImpl: options.calleFetch }),
    });
  }

  return new FakeCallPlacer({
    store: new D1FakeCallStore(env.DB, now),
    scheduler: options.scheduler,
    scenarioFor:
      options.scenarioFor ?? defaultScenario(config.CALLE_FAKE_DELAY_MS),
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
    responderPhone: responderFor(config, options.responderPhone),
    now,
    newId,
    exclusive: options.exclusive,
  });
}
