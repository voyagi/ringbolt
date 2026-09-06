import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptTurn } from "../src/calle/port.js";
import { Repo } from "../src/db/repo.js";
import { resetTables } from "./support/reset.js";
import { deliverWebhook, terminalCallFor } from "./support/webhook.js";

/**
 * The call this product has actually made, 23 times, and never once completed.
 *
 * Every attempt on 2026-08-22 came back the same way: Ringbolt's turns carried text, the owner's
 * turns carried none and lasted no time at all. It was not the handset, since another caller was
 * heard on it inside the same window, and it was not two calls colliding, since the first ran on
 * its own for a minute and sixteen seconds and failed identically.
 *
 * Nothing here proves what causes that. It is the product's answer to it: whatever the channel
 * does, a call where the person was never heard must not be able to change a production system.
 * The stand-in reproduces the shape so the answer can be run rather than argued about, and
 * `docs/two-way-audio.md` carries the evidence and what a live call would settle.
 */
const TOKEN = "test-dummy-intake-token-0123456789";

async function postAlert(): Promise<string> {
  const response = await SELF.fetch(`https://ringbolt.test/intake/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service: "checkout",
      title: "Payment errors above 20 percent",
      severity: "critical",
    }),
  });
  const accepted = (await response.json()) as { incident: string };
  return accepted.incident;
}

async function runOneCall(): Promise<string> {
  const incidentId = await postAlert();
  const call = await terminalCallFor(env.DB, incidentId);
  expect((await deliverWebhook(call)).status).toBe(200);
  return incidentId;
}

describe("a call where only Ringbolt could be heard", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.CALLE_FAKE_SCENARIO = "one_way_audio";
  });

  afterEach(() => {
    env.CALLE_FAKE_SCENARIO = "answers";
  });

  /**
   * The call reports the task completed, at high confidence, with a schema-valid decision to turn
   * checkout off in it. Every other check in the authorization gate passes. The only thing wrong
   * with it is that nobody said any of it out loud.
   */
  it("changes nothing and runs nothing", async () => {
    const incidentId = await runOneCall();

    const repo = new Repo(env.DB);
    expect(await repo.getServiceState("checkout")).toBeNull();
    const runs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_runs`,
    ).first<{ n: number }>();
    expect(runs?.n).toBe(0);

    // The refusal hands the incident to the next person, because a call nobody was heard on is
    // exactly the case a human should be told about. With nobody else in the rotation there is
    // nowhere to hand it to, so it closes rather than sitting on the alert.
    const incident = await repo.getIncident(incidentId);
    expect(incident?.state).toBe("failed");
    expect(incident?.outcome).toBe("escalation_exhausted");
  });

  it("says in the record why it refused", async () => {
    const incidentId = await runOneCall();

    const events = await new Repo(env.DB).listEvents(incidentId);
    const refusal = events.find((event) => event.kind === "action.refused");
    expect(refusal?.message).toContain("not one word");
    expect(refusal?.data).toMatchObject({ refusal: "responder_not_heard" });
  });

  /**
   * The evidence is kept whatever the outcome. A transcript that only has one side of the
   * conversation in it is the thing an operator needs to see to understand what happened, and
   * deleting it because the call was useless would hide the fault this exists to surface.
   */
  it("keeps the one sided transcript rather than discarding it", async () => {
    const incidentId = await runOneCall();

    const [record] = await new Repo(env.DB).listCallRecords(incidentId);
    // The record keeps the transcript as parsed JSON, typed unknown. The stand-in wrote it in the
    // adapter's shape, and the assertions below read it in that shape.
    const turns = (record?.transcript ?? []) as TranscriptTurn[];
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.filter((turn) => turn.speaker === "user")).not.toHaveLength(0);
    expect(
      turns.every((turn) => turn.speaker !== "user" || turn.text === ""),
    ).toBe(true);
  });

  /**
   * The control. The identical alert, the identical decision, on a call where the responder was
   * heard, changes the system. Without this the test above would pass just as well if the whole
   * loop were broken.
   */
  it("still acts on the same decision when the responder was heard", async () => {
    env.CALLE_FAKE_SCENARIO = "answers";
    const incidentId = await runOneCall();

    const repo = new Repo(env.DB);
    expect((await repo.getServiceState("checkout"))?.killSwitch).toBe(true);
    expect((await repo.getIncident(incidentId))?.state).toBe("resolved");
  });
});
