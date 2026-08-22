import { SELF } from "cloudflare:test";
import { vi } from "vitest";
import type { CallSnapshot } from "../../src/calle/port.js";

/**
 * The stand-in delivers its webhook to PUBLIC_BASE_URL, which nothing is listening on in a test, so
 * a test that wants the whole loop waits for the call to finish and then delivers the event itself.
 * That is the real shape of the thing anyway: the delivery is unsigned and carries almost nothing,
 * and the worker goes and reads the call back before it believes any of it.
 */
export async function terminalCallFor(
  db: D1Database,
  incidentId: string,
): Promise<CallSnapshot> {
  return vi.waitFor(
    async () => {
      const rows = await db
        .prepare(`SELECT snapshot FROM fake_calls`)
        .all<{ snapshot: string }>();
      const snapshots = rows.results.map(
        (row) => JSON.parse(row.snapshot) as CallSnapshot,
      );
      const match = snapshots.find(
        (snapshot) =>
          snapshot.metadata["incident_id"] === incidentId &&
          snapshot.status !== "queued",
      );
      if (match === undefined)
        throw new Error("the call has not reached a terminal state yet");
      return match;
    },
    { timeout: 5000, interval: 25 },
  );
}

export async function deliverWebhook(
  call: CallSnapshot,
  eventId = `evt_${crypto.randomUUID()}`,
): Promise<Response> {
  return SELF.fetch("https://ringbolt.test/webhooks/calle", {
    method: "POST",
    headers: { "content-type": "application/json", "CALL-E-Event-Id": eventId },
    body: JSON.stringify({
      id: eventId,
      type: "call.completed",
      created_at: new Date().toISOString(),
      data: { id: call.id, status: call.status, metadata: call.metadata },
    }),
  });
}
