import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import type { CallRecord } from "../src/db/repo.js";
import type { Incident } from "../src/domain/incident.js";
import { enforceRetention } from "../src/worker/retention.js";
import { resetTables } from "./support/reset.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-25T12:00:00.000Z");

const windows = { transcriptDays: 30, incidentDays: 365 };

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

/** A closed incident that finished at a given age, with everything an incident carries. */
async function closedIncident(
  repo: Repo,
  id: string,
  ageDays: number,
  state: Incident["state"] = "resolved",
): Promise<void> {
  const at = daysAgo(ageDays);
  await repo.createIncident({
    id,
    state,
    service: "checkout",
    title: "Payment errors above 20 percent",
    severity: "critical",
    detail: null,
    fingerprint: `fp_${id}`,
    source: null,
    startedAt: at,
    links: [],
    offeredActions: [],
    wakeAt: null,
    wakeReason: null,
    callAttempts: 1,
    rotationPosition: 0,
    contactId: null,
    callStartedAt: at,
    callId: `call_${id}`,
    outcome: "rollback:succeeded",
    createdAt: at,
    updatedAt: at,
  });
  await repo.appendEvent({
    id: `evt_${id}`,
    incidentId: id,
    at,
    kind: "alert.received",
    message: "checkout: Payment errors above 20 percent",
    data: null,
  });
  await recordCall(repo, id, ageDays);
}

async function recordCall(
  repo: Repo,
  incidentId: string,
  ageDays: number,
): Promise<void> {
  const record: CallRecord = {
    callId: `call_${incidentId}`,
    incidentId,
    contactId: null,
    status: "completed",
    taskCompleted: true,
    confidence: 0.93,
    summary: "The responder was reached and gave a decision.",
    structuredResult: { decision: "run_action", action_id: "rollback" },
    transcript: [
      { offsetSeconds: 0, speaker: "bot", text: "Calling about checkout." },
      { offsetSeconds: 9, speaker: "user", text: "Roll it back." },
    ],
    recordedAt: daysAgo(ageDays),
    redactedAt: null,
  };
  await repo.recordCall(record);
}

describe("the retention sweep", () => {
  let repo: Repo;

  beforeEach(async () => {
    await resetTables(env.DB);
    repo = new Repo(env.DB);
  });

  it("erases the words of a call past the transcript window and leaves the record", async () => {
    await closedIncident(repo, "inc_old", 40);

    const result = await enforceRetention(repo, windows, NOW);
    expect(result).toMatchObject({ redacted: 1, failed: 0 });

    const [call] = await repo.listCallRecords("inc_old");
    expect(call?.transcript).toEqual([]);
    expect(call?.summary).toBeNull();
    // The call itself is still on the record: an action run names the call that authorized it.
    expect(call?.status).toBe("completed");
    expect(call?.confidence).toBe(0.93);
    expect(call?.redactedAt).toBe(NOW.toISOString());
  });

  it("leaves a call inside the window alone", async () => {
    await closedIncident(repo, "inc_recent", 3);

    const result = await enforceRetention(repo, windows, NOW);
    expect(result.redacted).toBe(0);

    const [call] = await repo.listCallRecords("inc_recent");
    expect(call?.transcript).toHaveLength(2);
    expect(call?.redactedAt).toBeNull();
  });

  /**
   * An erased transcript and a call the responder was never heard on are both empty, and they mean
   * opposite things. The date the words went is what tells them apart, and a screen reads it.
   */
  it("says when the words went rather than leaving a call that looks silent", async () => {
    await closedIncident(repo, "inc_old", 40);
    await enforceRetention(repo, windows, NOW);

    const [call] = await repo.listCallRecords("inc_old");
    expect(call?.redactedAt).not.toBeNull();
  });

  it("does not erase the same call twice", async () => {
    await closedIncident(repo, "inc_old", 40);
    await enforceRetention(repo, windows, NOW);

    const second = await enforceRetention(repo, windows, NOW);
    expect(second.redacted).toBe(0);
  });

  /**
   * A retention window a webhook can undo is not a retention window. The provider retries deliveries
   * for a long time, and a redacted call being re-recorded would put the transcript back.
   */
  it("refuses to write a transcript back over an erased one", async () => {
    await closedIncident(repo, "inc_old", 40);
    await enforceRetention(repo, windows, NOW);

    await recordCall(repo, "inc_old", 40);

    const [call] = await repo.listCallRecords("inc_old");
    expect(call?.transcript).toEqual([]);
    expect(call?.redactedAt).not.toBeNull();
  });

  it("deletes a closed incident past the incident window, and everything under it", async () => {
    await closedIncident(repo, "inc_ancient", 400);

    const result = await enforceRetention(repo, windows, NOW);
    expect(result.deleted).toBe(1);

    expect(await repo.getIncident("inc_ancient")).toBeNull();
    expect(await repo.listEvents("inc_ancient")).toEqual([]);
    expect(await repo.listCallRecords("inc_ancient")).toEqual([]);
    expect(await repo.listActionRuns("inc_ancient")).toEqual([]);
  });

  /**
   * An open incident holds its fingerprint against a unique index, so deleting one would free that
   * fingerprint and the next repeat of its alert would telephone somebody about a problem already in
   * hand. Age is not a reason to do that.
   */
  it("never deletes an incident that is still open, whatever its age", async () => {
    await closedIncident(repo, "inc_stuck", 400, "calling");

    const result = await enforceRetention(repo, windows, NOW);
    expect(result.deleted).toBe(0);
    expect(await repo.getIncident("inc_stuck")).not.toBeNull();
  });

  /**
   * Money spent is money spent. A retention sweep that made the reported spend go down would be
   * reporting a figure nobody can reconcile against the provider's own bill.
   */
  it("keeps the call ledger when the incident it belonged to is deleted", async () => {
    await closedIncident(repo, "inc_ancient", 400);
    await repo.recordRealCall(
      "call_inc_ancient",
      "inc_ancient",
      daysAgo(400),
      "live",
    );

    await enforceRetention(repo, windows, NOW);

    expect(await repo.countRealCalls()).toBe(1);
  });

  it("works through a backlog in bounded batches rather than in one request", async () => {
    for (let index = 0; index < 3; index += 1) {
      await closedIncident(repo, `inc_old_${index}`, 40);
    }

    const result = await enforceRetention(repo, windows, NOW);
    expect(result.redacted).toBe(3);
  });
});

describe("erasing one person from the record", () => {
  let repo: Repo;

  beforeEach(async () => {
    await resetTables(env.DB);
    repo = new Repo(env.DB);
    await repo.createContact({
      id: "con_nadia",
      name: "Nadia",
      phone: "+31600000001",
      createdAt: daysAgo(100),
    });
  });

  async function incidentAnsweredByNadia(): Promise<void> {
    const at = daysAgo(2);
    await repo.createIncident({
      id: "inc_1",
      state: "resolved",
      service: "checkout",
      title: "Payment errors",
      severity: "critical",
      detail: null,
      fingerprint: "fp_1",
      source: null,
      startedAt: at,
      links: [],
      offeredActions: ["rollback"],
      wakeAt: null,
      wakeReason: null,
      callAttempts: 1,
      rotationPosition: 0,
      contactId: "con_nadia",
      callStartedAt: at,
      callId: "call_1",
      outcome: "rollback:succeeded",
      createdAt: at,
      updatedAt: at,
    });
    await repo.appendEvent({
      id: "evt_1",
      incidentId: "inc_1",
      at,
      kind: "call.placed",
      message: "Calling Nadia about checkout.",
      data: { contact: "Nadia" },
    });
    await repo.recordCall({
      callId: "call_1",
      incidentId: "inc_1",
      contactId: "con_nadia",
      status: "completed",
      taskCompleted: true,
      confidence: 0.93,
      summary: "Nadia was reached and gave a decision.",
      structuredResult: { decision: "run_action", action_id: "rollback" },
      transcript: [
        { offsetSeconds: 9, speaker: "user", text: "Roll it back." },
      ],
      recordedAt: at,
      redactedAt: null,
    });
    await repo.recordActionRun({
      id: "run_1",
      incidentId: "inc_1",
      actionId: "rollback",
      callId: "call_1",
      contactId: "con_nadia",
      authorizedBy: "Nadia",
      decision: { decision: "run_action" },
      parameters: {},
      stateBefore: null,
      stateAfter: null,
      outcome: "succeeded",
      detail: "rolled back",
      attempts: 1,
      durationMs: 42,
      verification: { verified: true },
      at,
    });
  }

  it("takes the name out of everything that copied it", async () => {
    await incidentAnsweredByNadia();
    const contact = await repo.getContact("con_nadia");
    if (contact === null) throw new Error("the contact was not created");

    const counts = await repo.eraseContact(
      contact,
      "a contact erased at their own request",
      NOW.toISOString(),
    );
    expect(counts).toMatchObject({
      calls: 1,
      actionRuns: 1,
      incidents: 1,
      events: 1,
    });

    expect(await repo.getContact("con_nadia")).toBeNull();

    const events = await repo.listEvents("inc_1");
    expect(events[0]?.message).toBe(
      "Calling a contact erased at their own request about checkout.",
    );
    expect(JSON.stringify(events[0]?.data)).not.toContain("Nadia");
  });

  it("erases the words of every call they answered", async () => {
    await incidentAnsweredByNadia();
    const contact = await repo.getContact("con_nadia");
    if (contact === null) throw new Error("the contact was not created");

    await repo.eraseContact(contact, "erased", NOW.toISOString());

    const [call] = await repo.listCallRecords("inc_1");
    expect(call?.transcript).toEqual([]);
    expect(call?.summary).toBeNull();
    expect(call?.contactId).toBeNull();
    expect(call?.redactedAt).toBe(NOW.toISOString());
  });

  /**
   * An action run with nobody on it reads as a production change nobody authorized, which is a
   * different claim and a false one. The record keeps saying a person authorized it.
   */
  it("keeps saying a person authorized the change", async () => {
    await incidentAnsweredByNadia();
    const contact = await repo.getContact("con_nadia");
    if (contact === null) throw new Error("the contact was not created");

    await repo.eraseContact(
      contact,
      "a contact erased at their own request",
      NOW.toISOString(),
    );

    const [run] = await repo.listActionRuns("inc_1");
    expect(run?.authorizedBy).toBe("a contact erased at their own request");
    expect(run?.contactId).toBeNull();
    expect(run?.outcome).toBe("succeeded");
  });
});
