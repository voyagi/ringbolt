import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Scheduler } from "../src/calle/port.js";
import { Repo } from "../src/db/repo.js";
import type {
  AlertPayload,
  IncidentState,
  WakeReason,
} from "../src/domain/incident.js";
import { readConfig } from "../src/worker/env.js";
import { reconcile } from "../src/worker/reconcile.js";
import {
  buildOrchestrator,
  immediateScheduler,
  unscheduledWakes,
} from "../src/worker/wiring.js";
import { resetTables } from "./support/reset.js";

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

/** The call is placed and then nothing ever resolves it, which is a call still ringing. */
const neverRuns: Scheduler = () => undefined;

const MINUTE = 60 * 1000;

/**
 * Opens an incident with no alarm behind it, which is the situation this sweep exists for: the
 * Durable Object's alarm is what normally comes back to an incident, and everything below is what
 * happens when that alarm was never set or was lost.
 */
async function openWith(scheduler: Scheduler): Promise<string> {
  const opened = await buildOrchestrator(env, readConfig(env), {
    scheduler,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
  }).open(alert);
  if (opened.kind !== "created")
    throw new Error("the incident was not created");
  return opened.incident.id;
}

function sweep() {
  return reconcile(env, { now: () => new Date() });
}

/**
 * Moves an incident's clocks into the past rather than moving the sweep's clock into the future.
 *
 * The sweep only decides which incidents to look at; what happens to one is decided inside its own
 * Durable Object, which reads the real clock and cannot be handed a fake one. Ageing the record is
 * the only way both halves see the same elapsed time, and a test that moved only the sweep would
 * measure the selection and quietly miss everything that follows it.
 */
async function age(id: string, minutes: number): Promise<void> {
  const at = new Date(Date.now() - minutes * MINUTE).toISOString();
  await env.DB.prepare(
    `UPDATE incidents SET updated_at = ?2,
       call_started_at = CASE WHEN call_started_at IS NULL THEN NULL ELSE ?2 END
     WHERE id = ?1`,
  )
    .bind(id, at)
    .run();
}

async function incidentAt(id: string) {
  const incident = await new Repo(env.DB).getIncident(id);
  if (incident === null) throw new Error("the incident vanished");
  return incident;
}

async function stateOf(id: string): Promise<string> {
  return (await incidentAt(id)).state;
}

async function outcomeOf(id: string): Promise<string | null> {
  return (await incidentAt(id)).outcome;
}

/**
 * Puts an incident where a failure part-way through the loop would have left it. The wake reason is
 * cleared unless one is named, because that is what "the timer was lost" looks like on the record,
 * and it is the difference between an incident the sweep wakes and one the sweep closes.
 */
async function forceState(
  id: string,
  state: IncidentState,
  parked: { wakeAt: number; reason: WakeReason } | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE incidents SET state = ?2, wake_at = ?3, wake_reason = ?4 WHERE id = ?1`,
  )
    .bind(
      id,
      state,
      parked === null
        ? null
        : new Date(Date.now() + parked.wakeAt * MINUTE).toISOString(),
      parked === null ? null : parked.reason,
    )
    .run();
}

async function countOf(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe("the reconciliation sweep", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  /**
   * The webhook is the happy path, not a guarantee, and the alarm that would normally cover a lost
   * one can itself be lost with the isolate that set it. Without this sweep the incident stays in
   * `calling` for ever, and an open incident answers every later repeat of that alert as a
   * duplicate, so a single dropped packet would quietly retire a service's alerts.
   *
   * The stand-in's delivery genuinely does not land here, so this is the real recovery path rather
   * than a simulated one, and it runs the identical code the alarm would have run.
   */
  it("finishes a call whose webhook and alarm both went missing", async () => {
    const incidentId = await openWith(immediateScheduler);
    expect(await stateOf(incidentId)).toBe("calling");
    await age(incidentId, 7);

    const result = await sweep();

    expect(result).toMatchObject({ examined: 1, woken: 1, closed: 0 });
    expect(await stateOf(incidentId)).toBe("resolved");
    expect(await countOf("action_runs")).toBe(1);
  });

  it("leaves a call that has only just been placed alone", async () => {
    const incidentId = await openWith(neverRuns);

    const result = await sweep();

    expect(result).toMatchObject({ examined: 0, woken: 0, closed: 0 });
    expect(await stateOf(incidentId)).toBe("calling");
  });

  /** A conversation that is genuinely still going gets more time rather than an escalation. */
  it("gives a call that is still running another deadline", async () => {
    const incidentId = await openWith(neverRuns);

    await age(incidentId, 7);

    const result = await sweep();

    expect(result).toMatchObject({ examined: 1, woken: 1 });
    const after = await incidentAt(incidentId);
    expect(after.state).toBe("calling");
    expect(after.wakeReason).toBe("no_answer");
  });

  /**
   * The ceiling on that rearming. It runs from when the call was placed rather than from the last
   * time anything touched the row, so rearming cannot push the deadline out for ever.
   */
  it("gives up on a call that never reached a terminal state", async () => {
    const incidentId = await openWith(neverRuns);

    await age(incidentId, 31);

    const result = await sweep();

    expect(result).toMatchObject({ examined: 1, woken: 1 });
    // Nobody else is in the rotation, so escalating has nowhere to go and the incident closes
    // rather than holding the alert open.
    expect(await stateOf(incidentId)).toBe("failed");
    expect(await outcomeOf(incidentId)).toBe("escalation_exhausted");
  });

  it("prunes webhook event ids past their retention window", async () => {
    const repo = new Repo(env.DB);
    await repo.claimEvent(
      "evt_ancient",
      "claim",
      "2026-01-01T00:00:00.000Z",
      "",
    );
    await repo.completeEvent(
      "evt_ancient",
      "claim",
      "2026-01-01T00:00:00.000Z",
    );

    const result = await sweep();

    expect(result.prunedEvents).toBe(1);
  });

  /**
   * An incident that stops anywhere counts as open, and an open incident answers every later repeat
   * of its alert as a duplicate, so a state with no way out is a way to silence a service for good.
   * These are the states where nothing was scheduled to come back, which means the record itself is
   * incomplete: a parked incident with no time on it, or a step lost with whatever was carrying it.
   *
   * Nothing here re-runs a remediation. Once an incident has stalled, Ringbolt does not know
   * whether the action took effect, and this product does not act on what it does not know.
   */
  const stalls: {
    state: IncidentState;
    lands: string;
    outcome: string;
  }[] = [
    { state: "received", lands: "failed", outcome: "call_never_placed" },
    { state: "acting", lands: "failed", outcome: "action_outcome_unknown" },
    { state: "escalating", lands: "failed", outcome: "escalation_unhandled" },
    { state: "snoozed", lands: "failed", outcome: "snooze_lost" },
    { state: "deferred", lands: "failed", outcome: "deferral_lost" },
    { state: "muted", lands: "filtered", outcome: "mute_lost" },
  ];

  it.each(stalls)(
    "closes an incident stopped in $state with no time on it, and frees its fingerprint",
    async ({ state, lands, outcome }) => {
      const incidentId = await openWith(neverRuns);
      await forceState(incidentId, state);
      await age(incidentId, 7);

      const result = await sweep();

      expect(result).toMatchObject({ examined: 1, closed: 1, woken: 0 });
      expect(await stateOf(incidentId)).toBe(lands);
      expect(await outcomeOf(incidentId)).toBe(outcome);

      const repeat = await buildOrchestrator(env, readConfig(env), {
        scheduler: neverRuns,
        exclusive: (work) => work(),
        wake: unscheduledWakes,
      }).open(alert);
      expect(repeat.kind).toBe("created");
    },
  );

  /**
   * A decision that never completed goes to a person rather than to a bin. With nobody else in the
   * rotation there is no such person, so the chain terminates in one step and the fingerprint is
   * freed. What matters is that it terminates at all.
   */
  it("hands a half-finished decision to the rotation, and that ends the chain", async () => {
    const incidentId = await openWith(neverRuns);
    await forceState(incidentId, "deciding");
    await age(incidentId, 7);

    expect(await sweep()).toMatchObject({ examined: 1, closed: 1 });
    expect(await stateOf(incidentId)).toBe("failed");
    expect(await outcomeOf(incidentId)).toBe("escalation_exhausted");

    const freed = await buildOrchestrator(env, readConfig(env), {
      scheduler: neverRuns,
      exclusive: (work) => work(),
      wake: unscheduledWakes,
    }).open(alert);
    expect(freed.kind).toBe("created");
  });

  it("leaves a snooze alone until the responder asked to be called back", async () => {
    const incidentId = await openWith(neverRuns);
    await forceState(incidentId, "snoozed", {
      wakeAt: 45,
      reason: "snooze_over",
    });

    const result = await sweep();

    expect(result).toMatchObject({ examined: 0, closed: 0, woken: 0 });
    expect(await stateOf(incidentId)).toBe("snoozed");
  });

  /**
   * A snooze whose alarm was lost. The sweep waits past the deadline by a grace period, so the
   * alarm normally gets there first, and then runs the same wake the alarm would have run.
   */
  it("calls back a snooze whose alarm never fired", async () => {
    const incidentId = await openWith(neverRuns);
    await forceState(incidentId, "snoozed", {
      wakeAt: -5,
      reason: "snooze_over",
    });

    const result = await sweep();

    expect(result).toMatchObject({ examined: 1, woken: 1, closed: 0 });
    const after = await incidentAt(incidentId);
    expect(after.state).toBe("calling");
    expect(after.callAttempts).toBe(2);
  });

  /**
   * A call with no deadline recorded is one nothing was ever going to check on. It cannot be closed
   * the way the other states are: somebody was telephoned and the result is unknown, so it goes to
   * the rotation. Without this it would be swept every minute for ever and never move.
   */
  it("does not leave a call with no deadline circling in the sweep", async () => {
    const incidentId = await openWith(neverRuns);
    await forceState(incidentId, "calling");
    await age(incidentId, 7);

    const result = await sweep();

    expect(result).toMatchObject({ examined: 1, closed: 1, woken: 0 });
    expect(await stateOf(incidentId)).toBe("failed");
    expect(await sweep()).toMatchObject({ examined: 0 });
  });
});
