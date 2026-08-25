import { Repo } from "../db/repo.js";
import type { Incident } from "../domain/incident.js";
import type { StallReason } from "../domain/orchestrator.js";
import type { Bindings } from "./env.js";
import { type IncidentActor, incidentStub } from "./incident-client.js";
import { WINDOW_RETENTION_MS } from "./limits.js";

/**
 * How long an incident may sit in a state where something is supposed to be happening to it before
 * the sweep treats it as stopped. Longer than the alarm's own interval on purpose: the alarm is the
 * mechanism and this is the backstop, so an incident whose alarm is working never gets here.
 */
const ACTIVE_STATE_MS = 6 * 60 * 1000;

/**
 * How far past its own deadline a parked incident has to be before the sweep steps in. The Durable
 * Object's alarm is what wakes it normally, and the grace is what keeps the two from racing to do
 * the same thing at the same moment.
 */
const WAKE_GRACE_MS = 2 * 60 * 1000;

/** Webhook event ids are kept long enough to answer a retry, and no longer. */
const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** One sweep looks at a bounded number of incidents so a backlog cannot exhaust a request. */
const BATCH = 25;

export type ReconcileResult = {
  examined: number;
  woken: number;
  closed: number;
  failed: number;
  prunedEvents: number;
};

/**
 * The backstop for an incident that stops moving, whatever stopped it. Ringbolt schedules its own
 * timers on the incident's Durable Object alarm, which is precise; this runs once a minute and
 * exists for the case where an alarm was never set, or was lost with the isolate that set it.
 *
 * One rule decides what happens, and it is the incident's own record that answers it. An incident
 * that knows what it is waiting for is woken, by calling the very same code the alarm calls, so
 * recovery and ordinary operation cannot drift apart. An incident that is waiting for nothing is
 * closed and the reason is named. Nothing here re-runs a remediation: once an incident has stalled
 * Ringbolt does not know whether the action took effect, and this product does not act on what it
 * does not know.
 *
 * Closing matters as much as waking. An open incident answers every later repeat of its alert as a
 * duplicate, so a state with no way out is a way to silence a service for good, with no signal to
 * anybody that it happened.
 */
export async function reconcile(
  env: Bindings,
  options: { now: () => Date },
): Promise<ReconcileResult> {
  const repo = new Repo(env.DB);
  const now = options.now();

  const stalled = await repo.findStalledIncidents(
    {
      active: isoBefore(now, ACTIVE_STATE_MS),
      wake: isoBefore(now, WAKE_GRACE_MS),
    },
    BATCH,
  );

  const result: ReconcileResult = {
    examined: stalled.length,
    woken: 0,
    closed: 0,
    failed: 0,
    prunedEvents: 0,
  };

  for (const incident of stalled) {
    // One incident's failure costs that incident this minute, not the whole sweep. The batch is
    // ordered oldest first, so without this a single incident that always throws would sit at the
    // head of every future batch and the backstop would never run again.
    try {
      await handle(incident, incidentStub(env, incident.fingerprint), result);
    } catch {
      result.failed += 1;
    }
  }

  try {
    result.prunedEvents = await repo.pruneProcessedEvents(
      isoBefore(now, EVENT_RETENTION_MS),
    );
    await repo.pruneRateWindows(isoBefore(now, WINDOW_RETENTION_MS));
  } catch {
    result.failed += 1;
  }

  return result;
}

async function handle(
  incident: Incident,
  owner: IncidentActor,
  result: ReconcileResult,
): Promise<void> {
  if (incident.wakeReason !== null) {
    await owner.wake(incident.id);
    result.woken += 1;
    return;
  }

  // A call with no deadline on it is one nothing was ever going to check. It cannot be closed the
  // way the other states are, because the state it has to leave for is escalation: somebody was
  // telephoned about this and the result is unknown, so it goes to the next person rather than to a
  // bin. Without this branch it would be swept every minute for ever and never move.
  if (incident.state === "calling") {
    await owner.abandonCall(
      incident.id,
      "the call had no deadline recorded, so nothing was ever going to check on it",
    );
    result.closed += 1;
    return;
  }

  await owner.closeStalled(incident.id, stallReasonFor(incident.state));
  result.closed += 1;
}

/**
 * Why an incident with no pending wake has stopped. Every one of these means the record itself is
 * incomplete: a parked incident that never got a time to wake up at, or a state whose next step was
 * lost with whatever was carrying it.
 */
function stallReasonFor(state: Incident["state"]): StallReason {
  switch (state) {
    case "received":
      return "call_never_placed";
    case "deciding":
      return "decision_not_completed";
    case "acting":
      return "action_outcome_unknown";
    case "snoozed":
      return "snooze_lost";
    case "deferred":
      return "deferral_lost";
    case "muted":
      return "mute_lost";
    default:
      return "escalation_unhandled";
  }
}

function isoBefore(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}
