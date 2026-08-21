import {
  D1FakeCallStore,
  FakeCallPlacer,
  type FakeScenario,
} from "../calle/fake.js";
import type { CallPlacer, PlaceCallInput, Scheduler } from "../calle/port.js";
import { Repo } from "../db/repo.js";
import type { Exclusive } from "../domain/orchestrator.js";
import { Orchestrator } from "../domain/orchestrator.js";
import {
  type Bindings,
  LIVE_MODE_AVAILABLE,
  type RingboltConfig,
} from "./env.js";

/**
 * Until phase 3 there is one responder, and until the owner supplies a number there is not even
 * one. The fake never dials, so this placeholder is only ever reached by the fake.
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
};

export type OrchestratorOptions = PlacerOptions & {
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

  if (config.CALLE_MODE === "fake") {
    return new FakeCallPlacer({
      store: new D1FakeCallStore(env.DB, now),
      scheduler: options.scheduler,
      scenarioFor:
        options.scenarioFor ?? defaultScenario(config.CALLE_FAKE_DELAY_MS),
      now,
    });
  }

  // readConfig refuses live mode while LIVE_MODE_AVAILABLE is false, so reaching this line means
  // the two have drifted apart. Fail closed rather than dial something that does not exist.
  throw new Error(
    LIVE_MODE_AVAILABLE
      ? "the live CALL-E placer is not wired up"
      : "live mode was accepted by the configuration but no CALL-E adapter is built",
  );
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
    responderPhone: options.responderPhone ?? UNCONFIGURED_RESPONDER,
    now,
    newId,
    exclusive: options.exclusive,
  });
}
