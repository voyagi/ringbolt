import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSnapshot } from "../src/calle/port.js";
import type { VerifiedCall } from "../src/calle/verify.js";
import { Repo } from "../src/db/repo.js";
import type { Incident, Severity } from "../src/domain/incident.js";
import type { ServicePolicy } from "../src/domain/policy.js";
import { defaultPolicy } from "../src/domain/policy.js";
import { readConfig } from "../src/worker/env.js";
import {
  buildOrchestrator,
  immediateScheduler,
  unscheduledWakes,
} from "../src/worker/wiring.js";
import { resetTables } from "./support/reset.js";

const TOKEN = "test-intake-token-0123456789";
const SERVICE = "checkout";
const TITLE = "Payment errors above 20 percent";
const MINUTE = 60 * 1000;

async function postAlert(
  severity: Severity = "critical",
): Promise<{ id: string; state: string }> {
  const response = await SELF.fetch(`https://ringbolt.test/intake/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: SERVICE, title: TITLE, severity }),
  });
  const accepted = (await response.json()) as {
    incident: string;
    state: string;
  };
  return { id: accepted.incident, state: accepted.state };
}

async function incidentAt(id: string): Promise<Incident> {
  const incident = await new Repo(env.DB).getIncident(id);
  if (incident === null) throw new Error("the incident vanished");
  return incident;
}

async function callsPlaced(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM incidents WHERE call_id IS NOT NULL`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Runs the incident to a decision without waiting on a webhook that cannot reach a test worker. */
async function resolve(incidentId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await env.DB.prepare(`SELECT snapshot FROM fake_calls`).all<{
        snapshot: string;
      }>();
      const call = rows.results
        .map((row) => JSON.parse(row.snapshot) as CallSnapshot)
        .find(
          (one) =>
            one.metadata["incident_id"] === incidentId &&
            one.status !== "queued",
        );
      if (call === undefined) throw new Error("the call is still running");
      return call;
    },
    { timeout: 5000, interval: 25 },
  );

  await buildOrchestrator(env, readConfig(env), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
  }).onCallTerminal({
    id: `call_stub_${incidentId}`,
    status: "completed",
    taskCompleted: true,
    confidenceScore: 0.95,
    confidenceLabel: "high",
    structuredResult: { decision: "run_action", action_id: "kill_switch" },
    summary: "The responder authorized the kill switch.",
    evidence: [],
    // An empty transcript is refused: nothing the responder said means nobody authorized anything.
    transcript: [
      { offsetSeconds: 0, speaker: "bot", text: "This is Ringbolt." },
      { offsetSeconds: 8, speaker: "user", text: "Turn it off." },
    ],
    metadata: { incident_id: incidentId, service: SERVICE },
    failureCode: null,
  } as VerifiedCall);
}

async function setPolicy(overrides: Partial<ServicePolicy>): Promise<void> {
  await new Repo(env.DB).upsertServicePolicy({
    ...defaultPolicy(
      SERVICE,
      ["kill_switch", "rollback"],
      new Date().toISOString(),
    ),
    ...overrides,
  });
}

/** Moves an incident's creation time back, which is what the suppression window is measured on. */
async function ageCall(id: string, minutes: number): Promise<void> {
  await env.DB.prepare(`UPDATE incidents SET created_at = ?2 WHERE id = ?1`)
    .bind(id, new Date(Date.now() - minutes * MINUTE).toISOString())
    .run();
}

describe("one broken thing is one phone call", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "answers";
  });

  /**
   * The phase's other headline. A service that flaps up and down all night is one telephone call,
   * not one per flap. Repeats while the incident is open are already collapsed by the fingerprint;
   * this is the harder half, which is repeats arriving after the last one was dealt with.
   */
  it("takes a storm of repeated alerts and rings once", async () => {
    const first = await postAlert();
    expect(first.state).toBe("calling");
    await resolve(first.id);
    expect((await incidentAt(first.id)).state).toBe("resolved");

    const second = await postAlert();
    expect(second.state).toBe("muted");

    // Everything after this collapses into the muted incident, because a muted incident is still
    // open and therefore still answers repeats of its own alert.
    for (let repeat = 0; repeat < 4; repeat += 1) {
      const later = await postAlert();
      expect(later.id).toBe(second.id);
    }

    expect(await callsPlaced()).toBe(1);
  });

  it("says when the suppression ends rather than suppressing silently", async () => {
    const first = await postAlert();
    await resolve(first.id);
    const second = await postAlert();

    const muted = await incidentAt(second.id);
    expect(muted.wakeReason).toBe("flap_window_over");
    expect(muted.wakeAt).not.toBeNull();

    const events = await new Repo(env.DB).listEvents(second.id);
    expect(events.map((event) => event.kind)).toContain("incident.muted");
  });

  /**
   * A suppressed incident ends by admitting nobody was called, never by calling late. Ringing an
   * hour afterwards about a problem that already rang a phone is the behaviour suppression exists
   * to prevent, so the window closing frees the fingerprint and the NEXT repeat is judged afresh.
   */
  it("closes the suppressed incident when the window ends, without a late call", async () => {
    const first = await postAlert();
    await resolve(first.id);
    const second = await postAlert();

    const orchestrator = buildOrchestrator(env, readConfig(env), {
      scheduler: immediateScheduler,
      exclusive: (work) => work(),
      wake: unscheduledWakes,
    });
    await orchestrator.wake(second.id);

    const ended = await incidentAt(second.id);
    expect(ended.state).toBe("filtered");
    expect(ended.outcome).toBe("flap_window_ended");
    expect(ended.callId).toBeNull();
    expect(await callsPlaced()).toBe(1);
  });

  it("rings again once the window has rolled past the last call", async () => {
    const first = await postAlert();
    await resolve(first.id);
    await ageCall(first.id, 20);

    const later = await postAlert();
    expect(later.state).toBe("calling");
    expect(await callsPlaced()).toBe(2);
  });

  it("lets a service that is allowed more calls have them", async () => {
    await setPolicy({ maxCallsPerWindow: 2 });

    const first = await postAlert();
    await resolve(first.id);
    const second = await postAlert();

    expect(second.state).toBe("calling");
    expect(await callsPlaced()).toBe(2);
  });
});

describe("a severity that is not worth a telephone", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "answers";
  });

  it("records the alert and calls nobody", async () => {
    await setPolicy({ minSeverity: "critical" });

    const alert = await postAlert("low");

    expect(alert.state).toBe("filtered");
    const filtered = await incidentAt(alert.id);
    expect(filtered.outcome).toBe("below_severity_threshold");
    expect(filtered.callId).toBeNull();
    expect(await callsPlaced()).toBe(0);
  });

  /**
   * Filtered is terminal, so it does not hold the fingerprint. A serious alert arriving straight
   * after a trivial one has to be able to open its own incident and ring.
   */
  it("does not stop the next serious alert from ringing", async () => {
    await setPolicy({ minSeverity: "critical" });
    await postAlert("low");

    const serious = await postAlert("critical");
    expect(serious.state).toBe("calling");
  });
});

describe("quiet hours", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "answers";
  });

  /** A window in UTC around the current minute, so the test does not depend on when it runs. */
  function aroundNow(minutesEitherSide: number) {
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    return {
      startMinute: (minute - minutesEitherSide + 1440) % 1440,
      endMinute: (minute + minutesEitherSide) % 1440,
      zone: "UTC",
      minSeverity: "critical" as const,
    };
  }

  it("holds a lesser alert instead of ringing, and says when it will call", async () => {
    await setPolicy({ quietHours: aroundNow(60) });

    const alert = await postAlert("high");

    expect(alert.state).toBe("deferred");
    const deferred = await incidentAt(alert.id);
    expect(deferred.wakeReason).toBe("quiet_hours_over");
    expect(Date.parse(deferred.wakeAt ?? "")).toBeGreaterThan(Date.now());
    expect(await callsPlaced()).toBe(0);
  });

  it("still rings for the severity that was allowed to break the window", async () => {
    await setPolicy({ quietHours: aroundNow(60) });

    expect((await postAlert("critical")).state).toBe("calling");
  });

  it("calls when the window has ended", async () => {
    await setPolicy({ quietHours: aroundNow(60) });
    const alert = await postAlert("high");
    expect(alert.state).toBe("deferred");

    // The window moves rather than the clock, which is the same thing from the incident's side and
    // does not need a fake clock inside the Durable Object.
    await setPolicy({ quietHours: null });
    await buildOrchestrator(env, readConfig(env), {
      scheduler: immediateScheduler,
      exclusive: (work) => work(),
      wake: unscheduledWakes,
    }).wake(alert.id);

    const woken = await incidentAt(alert.id);
    expect(woken.state).toBe("calling");
    expect(woken.callAttempts).toBe(1);
  });

  /**
   * Quiet hours end at a wall-clock time and the deadline was worked out by adding real minutes to
   * a real clock, so a daylight-saving change inside the window moves one relative to the other.
   * Asking the window again rather than trusting the deadline is what makes that self-correcting.
   */
  it("waits again when the window has not really ended yet", async () => {
    await setPolicy({ quietHours: aroundNow(60) });
    const alert = await postAlert("high");

    await buildOrchestrator(env, readConfig(env), {
      scheduler: immediateScheduler,
      exclusive: (work) => work(),
      wake: unscheduledWakes,
    }).wake(alert.id);

    const still = await incidentAt(alert.id);
    expect(still.state).toBe("deferred");
    expect(still.wakeReason).toBe("quiet_hours_over");
    expect(await callsPlaced()).toBe(0);
  });
});
