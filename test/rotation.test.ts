import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSnapshot } from "../src/calle/port.js";
import type { VerifiedCall } from "../src/calle/verify.js";
import { Repo, SHARED_ROTATION } from "../src/db/repo.js";
import type { AlertPayload, Incident } from "../src/domain/incident.js";
import type { WakeScheduler } from "../src/domain/orchestrator.js";
import { type Contact, effectiveRotation } from "../src/domain/rotation.js";
import { readConfig } from "../src/worker/env.js";
import { buildOrchestrator, immediateScheduler } from "../src/worker/wiring.js";
import { resetTables } from "./support/reset.js";

const TOKEN = "test-intake-token-0123456789";

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

const first: Contact = {
  id: "con_first",
  name: "the first responder",
  phone: "+31612345678",
  createdAt: "2026-08-21T09:00:00.000Z",
};

const second: Contact = {
  id: "con_second",
  name: "the second responder",
  phone: "+31698765432",
  createdAt: "2026-08-21T09:01:00.000Z",
};

async function seedRotation(
  contacts: Contact[],
  service = SHARED_ROTATION,
): Promise<void> {
  const repo = new Repo(env.DB);
  for (const contact of contacts) await repo.createContact(contact);
  await repo.setRotation(
    service,
    contacts.map((contact) => contact.id),
  );
}

/** Records what would have been scheduled, for the paths that are driven by hand. */
function recordingWakes(): WakeScheduler & { scheduled: Date[] } {
  const scheduled: Date[] = [];
  return {
    scheduled,
    schedule: async (_incidentId, at) => {
      scheduled.push(at);
    },
    clear: async () => undefined,
  };
}

function orchestratorWith(wake: WakeScheduler) {
  return buildOrchestrator(env, readConfig(env), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
    wake,
  });
}

async function postAlert(body: unknown = alert): Promise<string> {
  const response = await SELF.fetch(`https://ringbolt.test/intake/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const accepted = (await response.json()) as { incident: string };
  return accepted.incident;
}

async function incidentAt(id: string): Promise<Incident> {
  const incident = await new Repo(env.DB).getIncident(id);
  if (incident === null) throw new Error("the incident vanished");
  return incident;
}

/** Waits for the stand-in to finish the call it is currently on for this incident. */
async function callFinishes(
  incidentId: string,
  attempt: number,
): Promise<CallSnapshot> {
  return vi.waitFor(
    async () => {
      const rows = await env.DB.prepare(
        `SELECT snapshot FROM fake_calls WHERE idempotency_key = ?1`,
      )
        .bind(`${incidentId}:attempt-${attempt}`)
        .all<{ snapshot: string }>();
      const call = rows.results
        .map((row) => JSON.parse(row.snapshot) as CallSnapshot)
        .find((one) => one.status !== "queued");
      if (call === undefined) throw new Error("the call is still running");
      return call;
    },
    { timeout: 5000, interval: 25 },
  );
}

function ownerOf(fingerprint: string) {
  const namespace = env.INCIDENT;
  return namespace.get(namespace.idFromName(fingerprint));
}

/**
 * Scoped to one incident on purpose. The stand-in resolves a call on a timer through waitUntil, so
 * a call placed near the end of a test can finish writing after the next test has already cleared
 * the tables. Counting every row in there would make this suite depend on that timing.
 */
async function callsPlaced(incidentId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT idempotency_key FROM fake_calls WHERE idempotency_key LIKE ?1 ORDER BY idempotency_key ASC`,
  )
    .bind(`${incidentId}:%`)
    .all<{ idempotency_key: string }>();
  return rows.results.map((row) => row.idempotency_key);
}

describe("the rotation", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "answers";
  });

  /**
   * A fresh install has no contacts and still has to be able to ring the one number in the
   * configuration. Rotation lengthens the list rather than being the prerequisite for having one.
   */
  it("falls back to the configured number when nobody has been added", () => {
    const rotation = effectiveRotation([], "+31600000000", "now");
    expect(rotation).toHaveLength(1);
    expect(rotation[0]?.phone).toBe("+31600000000");
  });

  it("uses a service's own rota in preference to the shared one", async () => {
    await seedRotation([first]);
    await new Repo(env.DB).createContact(second);
    await new Repo(env.DB).setRotation("checkout", [second.id]);

    const repo = new Repo(env.DB);
    expect((await repo.rotationFor("checkout")).map((one) => one.id)).toEqual([
      second.id,
    ]);
    expect((await repo.rotationFor("search")).map((one) => one.id)).toEqual([
      first.id,
    ]);
  });

  it("calls the head of the rotation first", async () => {
    await seedRotation([first, second]);
    const incidentId = await postAlert();

    const incident = await incidentAt(incidentId);
    expect(incident.contactId).toBe(first.id);
    expect(incident.rotationPosition).toBe(0);
    expect(incident.callAttempts).toBe(1);
  });
});

describe("escalating on no answer", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "no_answer";
  });

  /**
   * The phase's headline: nobody picks up, and a precise timer hands the incident to the next
   * person. The timer is the incident's own Durable Object alarm, run here rather than waited on.
   * Nothing else moves this incident: the stand-in's webhook cannot reach a test worker, so what
   * is being measured is the alarm doing the whole job on its own.
   */
  it("hands an unanswered call to the second contact on the alarm", async () => {
    await seedRotation([first, second]);
    const incidentId = await postAlert();
    expect((await incidentAt(incidentId)).contactId).toBe(first.id);
    await callFinishes(incidentId, 1);

    const ran = await runDurableObjectAlarm(
      ownerOf((await incidentAt(incidentId)).fingerprint),
    );
    expect(ran).toBe(true);

    const escalated = await incidentAt(incidentId);
    expect(escalated.state).toBe("calling");
    expect(escalated.contactId).toBe(second.id);
    expect(escalated.rotationPosition).toBe(1);
    expect(escalated.callAttempts).toBe(2);
  });

  /**
   * A second call to a second person must not be folded into the first by the provider's own
   * deduplication, which is keyed on what Ringbolt sends. One key per attempt is what stops that.
   */
  it("gives the second call its own idempotency key", async () => {
    await seedRotation([first, second]);
    const incidentId = await postAlert();
    await callFinishes(incidentId, 1);
    await runDurableObjectAlarm(
      ownerOf((await incidentAt(incidentId)).fingerprint),
    );

    expect(await callsPlaced(incidentId)).toEqual([
      `${incidentId}:attempt-1`,
      `${incidentId}:attempt-2`,
    ]);
  });

  /**
   * The chain has to end. Two people, two calls, and then the incident closes and says so rather
   * than holding the alert open, which would answer every later repeat as a duplicate and take the
   * service off the air entirely.
   */
  it("closes the incident once everybody has been tried", async () => {
    await seedRotation([first, second]);
    const incidentId = await postAlert();
    const fingerprint = (await incidentAt(incidentId)).fingerprint;

    await callFinishes(incidentId, 1);
    await runDurableObjectAlarm(ownerOf(fingerprint));
    await callFinishes(incidentId, 2);
    await runDurableObjectAlarm(ownerOf(fingerprint));

    const closed = await incidentAt(incidentId);
    expect(closed.state).toBe("failed");
    expect(closed.outcome).toBe("escalation_exhausted");
    expect(await callsPlaced(incidentId)).toHaveLength(2);

    // The fingerprint is free again, so the next repeat of this alert rings rather than being
    // answered as a duplicate of an incident nobody is looking at.
    env.CALLE_FAKE_SCENARIO = "answers";
    const repeat = await postAlert();
    expect(repeat).not.toBe(incidentId);
  });
});

describe("calling back after a snooze", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "answers";
  });

  /**
   * "Call me back in twenty minutes" means call ME back. Moving down the rotation would hand a
   * problem somebody has already taken to somebody who has not heard about it.
   */
  it("rings the same person rather than the next one", async () => {
    await seedRotation([first, second]);
    const incidentId = await postAlert();

    const wake = recordingWakes();
    const orchestrator = orchestratorWith(wake);
    await orchestrator.onCallTerminal(
      snapshotFor(incidentId, { decision: "snooze", snooze_minutes: 20 }),
    );

    const snoozed = await incidentAt(incidentId);
    expect(snoozed.state).toBe("snoozed");
    expect(snoozed.wakeReason).toBe("snooze_over");

    await orchestrator.wake(incidentId);

    const calledBack = await incidentAt(incidentId);
    expect(calledBack.state).toBe("calling");
    expect(calledBack.contactId).toBe(first.id);
    expect(calledBack.rotationPosition).toBe(0);
    expect(calledBack.callAttempts).toBe(2);
  });

  it("does nothing when the incident has already moved on", async () => {
    await seedRotation([first]);
    const incidentId = await postAlert();

    const orchestrator = orchestratorWith(recordingWakes());
    await orchestrator.onCallTerminal(
      snapshotFor(incidentId, { decision: "hold" }),
    );
    expect((await incidentAt(incidentId)).state).toBe("held");

    await orchestrator.wake(incidentId);
    expect((await incidentAt(incidentId)).state).toBe("held");
  });
});

function snapshotFor(incidentId: string, decision: unknown): VerifiedCall {
  return {
    id: `call_stub_${incidentId}`,
    status: "completed",
    taskCompleted: true,
    confidenceScore: 0.94,
    confidenceLabel: "high",
    structuredResult: decision,
    summary: "The responder was reached and gave a decision.",
    evidence: [],
    // Somebody was heard on this call. An empty transcript is refused, and correctly so.
    transcript: [
      { offsetSeconds: 0, speaker: "bot", text: "This is Ringbolt." },
      { offsetSeconds: 8, speaker: "user", text: "Understood." },
    ],
    metadata: { incident_id: incidentId, service: "checkout" },
    failureCode: null,
  } as VerifiedCall;
}
