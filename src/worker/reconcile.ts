import type { CallStatus } from "../calle/port.js";
import { type VerifiedCall, verifyCall } from "../calle/verify.js";
import { Repo } from "../db/repo.js";
import { type Bindings, type RingboltConfig, readConfig } from "./env.js";
import { incidentStub } from "./incident-client.js";
import { type PlacerOptions, buildPlacer } from "./wiring.js";

/**
 * How long an incident may sit waiting on a call before the sweep goes and reads that call itself.
 * Long enough that an ordinary conversation is not interrupted, short enough that a lost delivery
 * is recovered while the incident still matters.
 */
const WAIT_FOR_THE_CALL_MS = 4 * 60 * 1000;

/** After this, a call that still has not reached a terminal state is treated as never returning. */
const GIVE_UP_AFTER_MS = 30 * 60 * 1000;

/** Webhook event ids are kept long enough to answer a retry, and no longer. */
const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** One sweep looks at a bounded number of incidents so a backlog cannot exhaust a request. */
const BATCH = 25;

export type ReconcileResult = {
  examined: number;
  finished: number;
  abandoned: number;
  unreadable: number;
  prunedEvents: number;
};

/**
 * The backstop for a webhook that never arrives, or arrives and cannot be processed. Without it the
 * only thing that ever moves an incident out of `calling` is a delivery from the provider, so a
 * single lost one leaves the incident open for ever, and an open incident answers every later
 * repeat of that alert as a duplicate. One dropped packet would silently retire a service's alerts.
 *
 * It reads the call back from the API exactly as the webhook path does and then hands the snapshot
 * to the same Durable Object, so recovery and normal operation run identical code.
 */
export async function reconcile(
  env: Bindings,
  options: PlacerOptions & { now: () => Date },
): Promise<ReconcileResult> {
  const config: RingboltConfig = readConfig(env);
  const repo = new Repo(env.DB);
  const now = options.now();

  const waiting = await repo.findCallsWaitingSince(
    isoBefore(now, WAIT_FOR_THE_CALL_MS),
    BATCH,
  );

  const result: ReconcileResult = {
    examined: waiting.length,
    finished: 0,
    abandoned: 0,
    unreadable: 0,
    prunedEvents: 0,
  };

  const placer = buildPlacer(env, config, options);

  for (const incident of waiting) {
    const owner = incidentStub(env, incident.fingerprint);
    const giveUp =
      Date.parse(incident.updatedAt) <= now.getTime() - GIVE_UP_AFTER_MS;

    if (incident.callId === null) {
      await owner.abandonCall(incident.id, "no call id was ever recorded");
      result.abandoned += 1;
      continue;
    }

    // Only the read is guarded. A failure handing the snapshot to its owner is a real fault and
    // belongs to the caller, not to a branch that would then close the incident on the strength of
    // its own error message.
    let snapshot: VerifiedCall | null = null;
    let status: string;
    try {
      snapshot = await verifyCall(placer, incident.callId);
      status = snapshot.status;
    } catch (error) {
      result.unreadable += 1;
      status = error instanceof Error ? error.message : "unreadable";
    }

    if (snapshot !== null && isTerminalCall(snapshot.status)) {
      await owner.callTerminal(snapshot);
      result.finished += 1;
      continue;
    }

    if (giveUp) {
      await owner.abandonCall(
        incident.id,
        `the call never reached a terminal state: ${status}`,
      );
      result.abandoned += 1;
    }
  }

  result.prunedEvents = await repo.pruneProcessedEvents(
    isoBefore(now, EVENT_RETENTION_MS),
  );

  return result;
}

function isTerminalCall(status: CallStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isoBefore(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}
