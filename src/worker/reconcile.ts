import { isTerminalCall } from "../calle/port.js";
import { type VerifiedCall, verifyCall } from "../calle/verify.js";
import { Repo } from "../db/repo.js";
import type { Incident } from "../domain/incident.js";
import type { StallReason } from "../domain/orchestrator.js";
import { type Bindings, type RingboltConfig, readConfig } from "./env.js";
import { type IncidentActor, incidentStub } from "./incident-client.js";
import { type PlacerOptions, buildPlacer } from "./wiring.js";

/**
 * How long an incident may sit waiting on a call before the sweep goes and reads that call itself,
 * and how long any other in-progress state may sit before it is treated as stopped. Long enough
 * that an ordinary conversation is not interrupted, short enough that a lost delivery is recovered
 * while the incident still matters.
 */
const ACTIVE_STATE_MS = 4 * 60 * 1000;

/** After this, a call that still has not reached a terminal state is treated as never returning. */
const GIVE_UP_AFTER_MS = 30 * 60 * 1000;

/**
 * How long an escalated incident waits for someone to pick it up. There is no rotation to hand it
 * to until phase 3, and an escalation that waits for ever holds its fingerprint for ever, which
 * means that service never rings again.
 */
const ESCALATION_MS = 30 * 60 * 1000;

/** Webhook event ids are kept long enough to answer a retry, and no longer. */
const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** One sweep looks at a bounded number of incidents so a backlog cannot exhaust a request. */
const BATCH = 25;

export type ReconcileResult = {
  examined: number;
  finished: number;
  abandoned: number;
  closed: number;
  unreadable: number;
  failed: number;
  prunedEvents: number;
};

/**
 * The backstop for an incident that stops moving, whatever stopped it. Without it the only thing
 * that ever advances an incident is a delivery from the provider, so a lost delivery, a failed
 * write halfway through a decision, or a call nobody answered leaves the incident open for ever.
 * An open incident answers every later repeat of its alert as a duplicate, so any state without a
 * way out is a way to silence a service permanently, with no signal to anyone that it happened.
 *
 * For a call that is still readable this is genuine recovery: it re-reads the call exactly as the
 * webhook path does and hands the snapshot to the same Durable Object, so recovery and normal
 * operation run identical code. For everything else it closes the incident and names why. It never
 * re-runs a remediation, because once an incident has stalled Ringbolt does not know whether the
 * action took effect, and this product does not act on what it does not know.
 */
export async function reconcile(
  env: Bindings,
  options: PlacerOptions & { now: () => Date },
): Promise<ReconcileResult> {
  const config: RingboltConfig = readConfig(env);
  const repo = new Repo(env.DB);
  const now = options.now();

  const stalled = await repo.findStalledIncidents(
    {
      active: isoBefore(now, ACTIVE_STATE_MS),
      escalating: isoBefore(now, ESCALATION_MS),
      now: now.toISOString(),
    },
    BATCH,
  );

  const result: ReconcileResult = {
    examined: stalled.length,
    finished: 0,
    abandoned: 0,
    closed: 0,
    unreadable: 0,
    failed: 0,
    prunedEvents: 0,
  };

  const placer = buildPlacer(env, config, options);

  for (const incident of stalled) {
    // One incident's failure costs that incident this minute, not the whole sweep. The batch is
    // ordered oldest first, so without this a single incident that always throws would sit at the
    // head of every future batch and the backstop would never run again.
    try {
      await handle(incident, incidentStub(env, incident.fingerprint), {
        placer,
        now,
        result,
      });
    } catch {
      result.failed += 1;
    }
  }

  try {
    result.prunedEvents = await repo.pruneProcessedEvents(
      isoBefore(now, EVENT_RETENTION_MS),
    );
  } catch {
    result.failed += 1;
  }

  return result;
}

type SweepContext = {
  placer: ReturnType<typeof buildPlacer>;
  now: Date;
  result: ReconcileResult;
};

async function handle(
  incident: Incident,
  owner: IncidentActor,
  context: SweepContext,
): Promise<void> {
  if (incident.state !== "calling") {
    await owner.closeStalled(incident.id, stallReasonFor(incident.state));
    context.result.closed += 1;
    return;
  }

  const giveUp =
    Date.parse(incident.updatedAt) <= context.now.getTime() - GIVE_UP_AFTER_MS;

  if (incident.callId === null) {
    await owner.abandonCall(incident.id, "no call id was ever recorded");
    context.result.abandoned += 1;
    return;
  }

  // Only the read is guarded. A failure handing the snapshot to its owner is a real fault and
  // belongs to the caller, not to a branch that would then close the incident on the strength of
  // its own error message.
  let snapshot: VerifiedCall | null = null;
  let status: string;
  try {
    snapshot = await verifyCall(context.placer, incident.callId);
    status = snapshot.status;
  } catch (error) {
    context.result.unreadable += 1;
    status = error instanceof Error ? error.message : "unreadable";
  }

  if (snapshot !== null && isTerminalCall(snapshot.status)) {
    await owner.callTerminal(snapshot);
    context.result.finished += 1;
    return;
  }

  if (giveUp) {
    await owner.abandonCall(
      incident.id,
      `the call never reached a terminal state: ${status}`,
    );
    context.result.abandoned += 1;
  }
}

function stallReasonFor(state: Incident["state"]): StallReason {
  switch (state) {
    case "received":
      return "call_never_placed";
    case "deciding":
      return "decision_not_completed";
    case "acting":
      return "action_outcome_unknown";
    case "snoozed":
      return "snooze_expired";
    default:
      return "escalation_unhandled";
  }
}

function isoBefore(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}
