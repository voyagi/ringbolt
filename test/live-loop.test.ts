import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CALL_PRICE_USD } from "../src/calle/port.js";
import { verifyCall } from "../src/calle/verify.js";
import { Repo, SHARED_ROTATION } from "../src/db/repo.js";
import type { AlertPayload } from "../src/domain/incident.js";
import { readConfig } from "../src/worker/env.js";
import {
  buildOrchestrator,
  buildPlacer,
  immediateScheduler,
  unscheduledWakes,
} from "../src/worker/wiring.js";
import {
  type CalleApiStub,
  aRecipient,
  anAttempt,
  calleApiStub,
} from "./support/calle-api.js";
import { resetTables } from "./support/reset.js";

/**
 * The same loop `test/loop.test.ts` runs against the stand-in, run again through the CALL-E
 * adapter. Everything on this path is the shipping code: the live placer, the SDK, the request
 * building, the verification step, the authorization gate and the action. Only the socket is
 * replaced, so the branch that only ever runs when a real telephone is involved is not left to be
 * proven by the handful of calls anybody is willing to pay for.
 */
const LIVE_ENV = {
  RINGBOLT_ENV: "production",
  CALLE_MODE: "live",
  PUBLIC_BASE_URL: "https://ringbolt.example.com",
  INTAKE_TOKEN: "a-long-enough-dummy-intake-token",
  CALLE_API_KEY: "test-dummy-key-live-loop",
  DEMO_PHONE: "+31612345678",
  CALLE_LOCALE: "en-GB",
  CALLE_REGION: "NL",
  // A dollar, which at five cents a call is twenty of them. A live build with nothing written down
  // here may spend nothing at all, which is the state a fresh deployment starts in.
  CALLE_CREDIT_USD: "1",
};

const CALLS_IN_THE_CREDIT = 1 / CALL_PRICE_USD;

/**
 * A conversation both sides took part in, in the shape the API nests it. A decision with no
 * responder speech behind it is refused, so a call that authorizes anything has to carry this.
 */
const heard = [
  { offset_seconds: 0, speaker: "bot" as const, text: "This is Ringbolt." },
  {
    offset_seconds: 11,
    speaker: "user" as const,
    text: "Turn it off while we look at it.",
  },
];

const alert: AlertPayload = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

/**
 * What the Durable Object's section does, in one isolate: run the callbacks one at a time. Held by
 * the tests that put two triggers on one incident, so that what they measure is the race the
 * section is supposed to close rather than the absence of a section.
 */
function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
}

function liveOrchestrator(api: CalleApiStub) {
  return buildOrchestrator(env, readConfig(LIVE_ENV), {
    scheduler: immediateScheduler,
    exclusive: (work) => work(),
    wake: unscheduledWakes,
    calleFetch: api.fetch,
  });
}

function livePlacer(api: CalleApiStub) {
  return buildPlacer(env, readConfig(LIVE_ENV), {
    scheduler: immediateScheduler,
    calleFetch: api.fetch,
  });
}

describe("the loop running on the CALL-E adapter", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  it("takes an alert all the way to a changed system", async () => {
    const api = calleApiStub();
    const orchestrator = liveOrchestrator(api);

    const opened = await orchestrator.open(alert);
    if (opened.kind !== "created") throw new Error("the incident was not made");
    const incident = opened.incident;
    expect(incident.state).toBe("calling");

    // The responder picks up and authorizes the kill switch. This is the shape CALL-E returns
    // when the call task carried a result schema and the conversation satisfied it.
    const callId = incident.callId;
    if (callId === null) throw new Error("no call was recorded");
    api.settle(callId, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 0.95, label: "high" },
      structured_result: {
        decision: "run_action",
        action_id: "kill_switch",
        reason: "Turn it off while we look at it.",
      },
      summary: "The responder authorized the kill switch.",
      recipients: [aRecipient([anAttempt({ transcript_turns: heard })])],
    });

    // Exactly what the webhook route does: re-read the call from the API under our own key rather
    // than believe the unsigned delivery, then hand that snapshot to the incident.
    const snapshot = await verifyCall(livePlacer(api), callId);
    await orchestrator.onCallTerminal(snapshot);

    const repo = new Repo(env.DB);
    const settled = await repo.getIncident(incident.id);
    expect(settled?.state).toBe("resolved");
    expect(await repo.getServiceState("checkout")).toMatchObject({
      killSwitch: true,
    });
  });

  /**
   * What CALL-E reports as `call.result_validation_failed`: the conversation happened and it is
   * confident the task was done, but nothing it heard fits the requested schema, so the task-level
   * result comes back null. A responder said something and it could not be pinned down, which is
   * the exact case this product exists to escalate rather than guess at.
   */
  it("escalates when the call completed but no decision could be pinned down", async () => {
    const api = calleApiStub();
    const orchestrator = liveOrchestrator(api);

    const opened = await orchestrator.open(alert);
    if (opened.kind !== "created") throw new Error("the incident was not made");
    const callId = opened.incident.callId;
    if (callId === null) throw new Error("no call was recorded");

    api.settle(callId, {
      status: "completed",
      task_completed: true,
      completion_confidence: { score: 0.95, label: "high" },
      structured_result: null,
      summary: "The responder was reached but no decision could be extracted.",
      recipients: [aRecipient([anAttempt({ transcript_turns: heard })])],
    });

    await orchestrator.onCallTerminal(
      await verifyCall(livePlacer(api), callId),
    );

    const repo = new Repo(env.DB);
    // With nobody else in the rotation the escalation has nowhere to go, so the incident closes
    // and says so rather than sitting on the alert. What matters here is that nothing ran.
    const settled = await repo.getIncident(opened.incident.id);
    expect(settled?.state).toBe("failed");
    expect(settled?.outcome).toBe("escalation_exhausted");
    const runs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_runs`,
    ).first<{ n: number }>();
    expect(runs?.n).toBe(0);
    expect(await repo.getServiceState("checkout")).toBeNull();
  });

  /**
   * CALL-E validates the task before it will create one, and it rejected the first real attempt
   * with "who should the bot say is calling in the opening sentence?". The instruction said to say
   * who was calling without ever saying who that was. Nothing was dialled and nothing was spent,
   * but the rejection cost a go-live attempt, so the caller's name is pinned here.
   */
  it("tells the caller who to say they are", async () => {
    const api = calleApiStub();
    await liveOrchestrator(api).open(alert);

    const task = api.creates[0]?.body["task"];
    expect(typeof task).toBe("string");
    expect(task).toContain("Ringbolt");
    expect(task).toContain("names you as Ringbolt");
  });

  /** A real call is dialled at the configured number, and the API is told to call that number. */
  it("dials the configured number and nothing else", async () => {
    const api = calleApiStub();
    await liveOrchestrator(api).open(alert);

    expect(api.creates[0]?.body["recipients"]).toEqual([
      { phones: ["+31612345678"], locale: "en-GB", region: "NL" },
    ]);
  });

  it("counts the call against the credit the product reports", async () => {
    const api = calleApiStub();
    await liveOrchestrator(api).open(alert);

    expect(await new Repo(env.DB).countRealCalls()).toBe(1);
  });

  /**
   * The credit running out must close the incident rather than leave it open, because an open
   * incident answers every later repeat of that alert as a duplicate and the service goes quiet.
   */
  it("closes the incident instead of leaving it open when the credit is gone", async () => {
    const repo = new Repo(env.DB);
    for (let spent = 0; spent < CALLS_IN_THE_CREDIT; spent += 1) {
      // Dated well outside the burst window on purpose: what is being tested is the ceiling on the
      // total, and a recent row would be refused by the rate guard before it ever got there.
      await repo.recordRealCall(
        `call_already_spent_${spent}`,
        `inc_spent_${spent}`,
        "2026-08-21T10:00:00.000Z",
        "live",
      );
    }

    const api = calleApiStub();
    const result = await liveOrchestrator(api).open(alert);

    expect(result.kind).toBe("call_failed");
    expect(result.incident.state).toBe("failed");
    expect(api.creates).toHaveLength(0);
  });

  /**
   * The exact shape CALL-E described on 2026-08-24: the call was accepted and the answer never
   * reached us. Sending again with the same key returns the call they already made. Sending again
   * with a NEW key is billed as a second independent call, which is what emptied the balance.
   */
  it("recovers a call whose answer never arrived rather than making a second one", async () => {
    const api = calleApiStub();
    api.dropAnswers(1);

    const opened = await liveOrchestrator(api).open(alert);

    expect(opened.kind).toBe("created");
    expect(opened.incident.state).toBe("calling");
    expect(api.creates).toHaveLength(2);
    expect(api.creates[0]?.idempotencyKey).toBe(api.creates[1]?.idempotencyKey);

    // One call task on their side, and one row on ours. A second key here is a second phone call
    // to a real person and a second charge.
    expect(api.ids()).toHaveLength(1);
    expect(await new Repo(env.DB).countRealCalls()).toBe(1);
  });

  /**
   * Both sends went onto the wire and neither could be settled, so a call may be ringing that this
   * incident will never hear about. Saying that is the only honest answer: the alternative is an
   * incident that reads "failed" while somebody's telephone is going.
   */
  it("says a call may exist when neither send could be settled", async () => {
    const api = calleApiStub();
    api.dropAnswers(2);

    const result = await liveOrchestrator(api).open(alert);

    expect(result.kind).toBe("call_failed");
    expect(result.incident.state).toBe("failed");
    expect(result.incident.outcome).toBe("call_outcome_unknown");
    expect(api.creates).toHaveLength(2);
    expect(new Set(api.creates.map((one) => one.idempotencyKey)).size).toBe(1);
    expect(api.ids()).toHaveLength(1);

    const events = await new Repo(env.DB).listEvents(result.incident.id);
    const failure = events.find((event) => event.kind === "call.place_failed");
    expect(failure?.message).toContain("a call may exist");
    expect(failure?.data).toMatchObject({ reachedTheProvider: true });
  });

  /**
   * The same case, counted rather than described. A call task exists on their side, so it is billed
   * whether or not the answer reached us, and the ledger is what both spending guards read: the
   * credit ceiling and the ten minute rate limit. Leaving this uncounted makes both of them blind in
   * the one failure mode that emptied the balance on 2026-08-22, because a provider answering slowly
   * fails this way for every call at once and the rate limit never sees a single one of them.
   */
  it("counts a call that may exist against the credit and the rate limit", async () => {
    const api = calleApiStub();
    api.dropAnswers(2);

    const result = await liveOrchestrator(api).open(alert);
    expect(result.kind).toBe("call_failed");
    expect(api.ids()).toHaveLength(1);

    const repo = new Repo(env.DB);
    expect(await repo.countRealCalls()).toBe(1);
    expect(await repo.countRealCallsSince("2026-08-21T00:00:00.000Z")).toBe(1);
  });

  /**
   * The other half of the same question, and the reason the answer is not simply "count everything
   * that reached the wire". CALL-E validated the first real go-live attempt and refused it with
   * "who should the bot say is calling in the opening sentence?". That is their decision not to make
   * a call, so nothing exists, nothing was billed, and sending it a second time only asks a
   * validator that has already answered. Counting it would spend the credit on calls nobody made and
   * then refuse the real ones, which on an on-call tool is the telephone quietly going dead.
   */
  it("does not re-send or count a call CALL-E refused outright", async () => {
    const api = calleApiStub();
    api.rejectCreates(5, 422, "invalid_request");

    const result = await liveOrchestrator(api).open(alert);

    expect(result.kind).toBe("call_failed");
    expect(api.creates).toHaveLength(1);
    expect(api.ids()).toHaveLength(0);

    const repo = new Repo(env.DB);
    expect(await repo.countRealCalls()).toBe(0);

    const failure = (await repo.listEvents(result.incident.id)).find(
      (event) => event.kind === "call.place_failed",
    );
    expect(failure?.data).toMatchObject({ reachedTheProvider: false });
    expect(failure?.message).not.toContain("a call may exist");
  });

  /**
   * The boundary the rule above is drawn at, pinned rather than described. A refusal for rate is not
   * the same as a refusal on the merits: it can arrive after the request was taken in, so whether a
   * task exists is the one thing nobody can answer, and a maybe is read as a yes by everything that
   * spends money here.
   */
  it("treats a rate refusal as a call that may exist", async () => {
    const api = calleApiStub();
    api.rejectCreates(5, 429, "rate_limited");

    const result = await liveOrchestrator(api).open(alert);

    expect(result.kind).toBe("call_failed");
    expect(api.creates).toHaveLength(2);
    expect(await new Repo(env.DB).countRealCalls()).toBe(1);
  });

  /**
   * Two triggers can decide to escalate one incident at the same moment: the incident's own alarm
   * and the reconciliation sweep that backs it up. The incident is claimed into `calling` inside the
   * exclusive section so that the second one finds it already claimed and stops.
   *
   * The section is held here exactly as the Durable Object holds it, which is the point: the state
   * each trigger claims from is read BEFORE the section, so holding the section is not on its own
   * enough. A second create with the same idempotency key is the only thing between this and two
   * telephones ringing about one problem, and that key is computed from the same stale read.
   */
  it("places one call when two triggers escalate at the same moment", async () => {
    const repo = new Repo(env.DB);
    for (const id of ["con_first", "con_second"]) {
      await repo.createContact({
        id,
        name: id,
        // Both on the configured number, which is the only one this build may dial.
        phone: "+31612345678",
        createdAt: "2026-08-21T09:00:00.000Z",
      });
    }
    await repo.setRotation(SHARED_ROTATION, ["con_first", "con_second"]);

    const api = calleApiStub();
    const orchestrator = buildOrchestrator(env, readConfig(LIVE_ENV), {
      scheduler: immediateScheduler,
      exclusive: oneAtATime(),
      wake: unscheduledWakes,
      calleFetch: api.fetch,
    });

    const opened = await orchestrator.open(alert);
    if (opened.kind !== "created") throw new Error("the incident was not made");
    expect(api.creates).toHaveLength(1);

    await repo.updateIncident(
      opened.incident.id,
      { state: "escalating" },
      "2026-08-21T12:05:00.000Z",
    );

    await Promise.all([
      orchestrator.escalate(opened.incident.id),
      orchestrator.escalate(opened.incident.id),
    ]);

    // The first call and one escalation. A third create is the second trigger dialling as well.
    expect(api.creates).toHaveLength(2);
    expect(api.ids()).toHaveLength(2);

    const placed = (await repo.listEvents(opened.incident.id)).filter(
      (event) => event.kind === "call.placed",
    );
    expect(placed).toHaveLength(2);
  });

  /**
   * The rate guard, through the whole loop rather than at the adapter. Three separate alerts about
   * three different things are three legitimate calls; the fourth inside ten minutes is the shape
   * that emptied the balance on 2026-08-22, so it is refused before anything is sent.
   */
  it("stops calling after three in ten minutes, whatever the credit says", async () => {
    const api = calleApiStub();
    const orchestrator = liveOrchestrator(api);

    for (let n = 1; n <= 3; n += 1) {
      const opened = await orchestrator.open({
        ...alert,
        title: `Payment errors above 20 percent on host ${n}`,
      });
      expect(opened.kind).toBe("created");
    }
    expect(api.creates).toHaveLength(3);

    const refused = await orchestrator.open({
      ...alert,
      title: "Payment errors above 20 percent on host 4",
    });

    expect(refused.kind).toBe("call_failed");
    expect(api.creates).toHaveLength(3);
    expect(refused.incident.state).toBe("failed");
    expect(refused.incident.outcome).toBe("call_place_refused");
  });
});
