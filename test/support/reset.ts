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
  "call_records",
  "processed_events",
  "call_ledger",
  "rotation",
  "contacts",
  "service_policy",
  "incidents",
  "service_state",
  "fake_calls",
] as const;

/**
 * Action definitions are configuration rather than data: migration 0005 seeds the two the product
 * ships with, and a fresh install is supposed to have them. So a reset removes what a test added
 * and leaves the seed alone, rather than emptying the table and giving every later test an install
 * that can offer nothing at all.
 */
const SEEDED_ACTIONS = "'kill_switch', 'rollback'";

export async function resetTables(db: D1Database): Promise<void> {
  for (const table of TABLES) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare(
      `DELETE FROM action_definitions WHERE id NOT IN (${SEEDED_ACTIONS})`,
    )
    .run();
}
