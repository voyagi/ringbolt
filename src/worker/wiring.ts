import { secretBindingPattern } from "../actions/definition.js";
import {
  D1FakeCallStore,
  FakeCallPlacer,
  type FakeScenario,
  type FakeScenarioKind,
} from "../calle/fake.js";
import { LiveCallPlacer } from "../calle/live.js";
import type { CallPlacer, PlaceCallInput, Scheduler } from "../calle/port.js";
import { Repo } from "../db/repo.js";
import { DEMO_SERVICE, HEALTHY_RELEASE } from "../demo/service.js";
import type {
  ActionEnvironment,
  Exclusive,
  WakeScheduler,
} from "../domain/orchestrator.js";
import { Orchestrator } from "../domain/orchestrator.js";
import {
  type Bindings,
  type RingboltConfig,
  allowedActionHosts,
  allowedLiveNumbers,
} from "./env.js";

/**
 * Dialled when nothing has been configured and no rotation exists. It fails the E.164 check live
 * mode's number has to pass, so it cannot become a real call.
 */
const UNCONFIGURED_RESPONDER = "+00000000000";

/**
 * How long a request to CALL-E may take before we stop waiting for it.
 *
 * Their SDK sets no timeout of its own, and a create that hangs is worse than one that fails: the
 * call may already have been accepted on their side, and every second we wait is a second in which
 * the incident's other timers can decide something. Twenty seconds is well past a healthy create
 * and well short of any of our own deadlines.
 */
const CALLE_REQUEST_TIMEOUT_MS = 20_000;

const boundedFetch = (request: Request): Promise<Response> =>
  fetch(request, { signal: AbortSignal.timeout(CALLE_REQUEST_TIMEOUT_MS) });

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

/**
 * The conversation the stand-in rehearses when the call is about the demo service.
 *
 * The demo has to show what this product actually claims rather than the shortest route to a
 * decision: somebody asks a question, gets an answer, names the release they want back, and then
 * says the exact words the action demanded. The deck draws its line from that sentence down into
 * the action it allowed, and it draws it only where those words are really present, so a demo
 * without them would be a demo missing the one graphic the whole product is about.
 *
 * It replaces only the DEFAULT scenario. A deployment that has asked the stand-in for a no answer
 * or a hang-up gets that on the demo service too, because choosing a scenario is how the refusal
 * paths are exercised.
 */
function demoConversation(afterMs: number): FakeScenario {
  return {
    kind: "answers",
    afterMs,
    confidence: 0.93,
    decision: {
      decision: "run_action",
      action_id: "rollback",
      confirmation_phrase: "roll it back",
      action_parameters: { release: HEALTHY_RELEASE },
      reason: "The release is the only thing that changed.",
    },
    turns: [
      {
        offsetSeconds: 12,
        speaker: "user",
        text: "Is anything else touching payments?",
      },
      {
        offsetSeconds: 15,
        speaker: "bot",
        text: "No. Search and accounts are both clean, and the only change in the window is that release.",
      },
      {
        offsetSeconds: 21,
        speaker: "user",
        text: `Put it back on ${HEALTHY_RELEASE} then.`,
      },
      {
        offsetSeconds: 26,
        speaker: "bot",
        text: `I can roll ${DEMO_SERVICE} back to ${HEALTHY_RELEASE}. Say roll it back to confirm.`,
      },
      { offsetSeconds: 31, speaker: "user", text: "Roll it back." },
    ],
  };
}

function defaultScenario(
  config: RingboltConfig,
  input: PlaceCallInput,
): FakeScenario {
  const afterMs = config.CALLE_FAKE_DELAY_MS;
  if (
    config.CALLE_FAKE_SCENARIO === "answers" &&
    input.metadata["service"] === DEMO_SERVICE
  ) {
    return demoConversation(afterMs);
  }
  return scenarioOf(config.CALLE_FAKE_SCENARIO, afterMs);
}

/** What the stand-in does on a call, chosen by configuration rather than by the code path. */
function scenarioOf(kind: FakeScenarioKind, afterMs: number): FakeScenario {
  // The two scenarios that reach the authorization gate with something in them need a decision to
  // carry. They carry the SAME one on purpose: the only difference between them is whether the
  // person was heard saying it, which is the whole question one_way_audio exists to ask.
  if (kind !== "answers" && kind !== "one_way_audio") return { kind, afterMs };
  return {
    kind,
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
   * The transport a runbook action's own request goes out on, and the wait between its retries.
   * The product wants the platform's fetch and a real timer; a test that has configured an action
   * reaching outside supplies both so that it stays a test.
   */
  actionFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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
    const repo = new Repo(env.DB);
    return new LiveCallPlacer({
      apiKey: config.CALLE_API_KEY,
      // The ledger is what the product reports at /api/budget, so the ceiling and the published
      // figure are the same count rather than two that can disagree.
      budget: {
        creditUsd: config.CALLE_CREDIT_USD,
        spent: () => repo.countRealCalls(),
        placedSince: (iso) => repo.countRealCallsSince(iso),
      },
      allowedNumbers: allowedLiveNumbers(config),
      locale: config.CALLE_LOCALE,
      region: config.CALLE_REGION,
      now,
      fetchImpl: options.calleFetch ?? boundedFetch,
    });
  }

  return new FakeCallPlacer({
    store: new D1FakeCallStore(env.DB, now),
    scheduler: options.scheduler,
    scenarioFor:
      options.scenarioFor ?? ((input) => defaultScenario(config, input)),
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

/**
 * Only a binding whose name says it is for runbook actions can be read as one. The definition
 * schema already refuses any other name; this is the same rule at the other end, so that a stored
 * row from before that rule existed still cannot reach the CALL-E key or the admin token.
 */
function readSecret(env: Bindings, binding: string): string | undefined {
  if (!secretBindingPattern.test(binding)) return undefined;
  const value = env[binding];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function actionEnvironment(
  env: Bindings,
  config: RingboltConfig,
  options: Pick<OrchestratorOptions, "actionFetch" | "sleep">,
): ActionEnvironment {
  return {
    http: options.actionFetch ?? ((input, init) => fetch(input, init)),
    sleep:
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    secret: (binding) => readSecret(env, binding),
    allowedHosts: allowedActionHosts(config),
  };
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
    actions: actionEnvironment(env, config, options),
  });
}
