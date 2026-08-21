import {
  D1FakeCallStore,
  FakeCallPlacer,
  type FakeScenario,
} from "../calle/fake.js";
import type { CallPlacer, PlaceCallInput, Scheduler } from "../calle/port.js";
import { Repo } from "../db/repo.js";
import { Orchestrator } from "../domain/orchestrator.js";
import type { Bindings, RingboltConfig } from "./env.js";

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

export type WiringOptions = {
  scheduler: Scheduler;
  now?: () => Date;
  scenarioFor?: (input: PlaceCallInput) => FakeScenario;
  responderPhone?: string;
};

export function buildPlacer(
  env: Bindings,
  config: RingboltConfig,
  options: WiringOptions,
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

  throw new Error("the live CALL-E placer arrives in phase 2");
}

export function buildOrchestrator(
  env: Bindings,
  config: RingboltConfig,
  options: WiringOptions,
): Orchestrator {
  const now = options.now ?? (() => new Date());
  return new Orchestrator({
    repo: new Repo(env.DB),
    placer: buildPlacer(env, config, options),
    publicBaseUrl: config.PUBLIC_BASE_URL,
    responderPhone: options.responderPhone ?? UNCONFIGURED_RESPONDER,
    now,
    newId,
  });
}
