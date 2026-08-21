/**
 * Everything the product writes, in an order that respects the foreign keys, cleared between tests.
 *
 * One list rather than a copy per suite. A table added later and missed in one file leaks rows into
 * whichever test happens to run next, and that shows up as a failure somewhere unrelated to the
 * change that caused it.
 */
const TABLES = [
  "incident_events",
  "action_runs",
  "processed_events",
  "call_ledger",
  "rotation",
  "contacts",
  "service_policy",
  "incidents",
  "service_state",
  "fake_calls",
] as const;

export async function resetTables(db: D1Database): Promise<void> {
  for (const table of TABLES) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}
