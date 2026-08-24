#!/usr/bin/env node
// Rehearses losing the database and getting it back, against the LOCAL D1 only.
//
// A restore procedure nobody has run is a paragraph, not a plan. This does the whole thing on the
// local database: seed it, export it, destroy the tables, import the export, and compare the row
// counts either side. It prints how long each step took, which is the number docs/RUNBOOK.md
// quotes.
//
// It cannot touch the deployed database: every wrangler call below carries --local, and the script
// refuses to run if any of them is missing it.
//
//   node scripts/restore-rehearsal.mjs
//
// The remote leg is the same two commands without --local, and it is deliberately not automated
// here: a scripted restore of production is a foot gun, and the runbook says to type it.

import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), ".wrangler", "rehearsal");
const DUMP = join(OUT_DIR, "rehearsal.sql");
const SEED = join(OUT_DIR, "seed.sql");
const SEED_ROWS = 2000;

/**
 * Read from the database rather than listed here. A hardcoded list goes stale the first time a
 * migration adds a table, and a restore rehearsal that silently skips the newest table is worse
 * than none: it would pass while the thing nobody had backed up stayed missing.
 */
function tablesInDatabase() {
  const { out } = sql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    "list tables",
  );
  const names = [...out.matchAll(/"name":\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (names.length === 0) throw new Error("no tables found to rehearse against");
  return names;
}

function wrangler(args, label, expectFailure = false) {
  if (!args.includes("--local")) {
    throw new Error(`refusing to run "${label}" without --local`);
  }
  const started = Date.now();
  const run = spawnSync("npx", ["wrangler", ...args], {
    shell: true,
    encoding: "utf8",
  });
  const ms = Date.now() - started;
  if (run.status !== 0) {
    // One caller runs a query it EXPECTS to fail, and printing wrangler's error there makes a
    // passing rehearsal look like a broken one.
    if (!expectFailure) {
      console.error(run.stdout);
      console.error(run.stderr);
    }
    throw new Error(`${label} failed with exit ${run.status}`);
  }
  return { ms, out: run.stdout };
}

function sql(command, label, expectFailure = false) {
  return wrangler(
    ["d1", "execute", "ringbolt", "--local", "--command", `"${command}"`],
    label,
    expectFailure,
  );
}

/** The count of every row the product owns, which is what a restore has to bring back. */
function rowCount(tables, expectFailure = false) {
  // Scalar subqueries added together rather than a UNION ALL of counts: D1 refuses a compound
  // SELECT this wide with "too many terms in compound SELECT".
  const sum = tables.map((table) => `(SELECT COUNT(*) FROM ${table})`).join(
    " + ",
  );
  const { out } = sql(`SELECT ${sum} AS total`, "count rows", expectFailure);
  const total = /"total":\s*(\d+)/.exec(out)?.[1];
  if (total === undefined) throw new Error("could not read the row count back");
  return Number(total);
}

const COLUMNS =
  "id,state,service,title,severity,detail,fingerprint,source,started_at,links,offered_actions,wake_at,wake_reason,call_attempts,rotation_position,contact_id,call_started_at,created_at,updated_at,call_id,outcome";

/** Small enough that no single statement trips SQLITE_TOOBIG, which one insert of 2000 does. */
const ROWS_PER_STATEMENT = 100;

function seed(rows) {
  // Its own rows first, so a rehearsal that failed half way through does not make the next one
  // fail on a primary key instead of on whatever is actually wrong.
  const statements = ["DELETE FROM incidents WHERE id LIKE 'inc_rehearsal_%';"];
  for (let start = 0; start < rows; start += ROWS_PER_STATEMENT) {
    const values = Array.from(
      { length: Math.min(ROWS_PER_STATEMENT, rows - start) },
      (_, offset) => {
        const index = start + offset;
        return `('inc_rehearsal_${index}','filtered','rehearsal','seeded row ${index}','low',NULL,'fp_rehearsal_${index}',NULL,NULL,'[]','[]',NULL,NULL,0,0,NULL,NULL,'2026-08-24T00:00:00.000Z','2026-08-24T00:00:00.000Z',NULL,'seeded')`;
      },
    ).join(",");
    statements.push(`INSERT INTO incidents (${COLUMNS}) VALUES ${values};`);
  }

  // Through a file rather than --command: two thousand rows of SQL is far past the length a
  // Windows command line accepts, and the failure is an exit code of null with no message.
  writeFileSync(SEED, `${statements.join("\n")}\n`);
  return wrangler(
    ["d1", "execute", "ringbolt", "--local", "--file", SEED, "-y"],
    `seed ${rows} incidents`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
rmSync(DUMP, { force: true });

const tables = tablesInDatabase();
console.log(`[rehearsal] ${tables.length} tables: ${tables.join(", ")}`);

console.log(`[rehearsal] seeding ${SEED_ROWS} rows`);
const seeded = seed(SEED_ROWS);
const before = rowCount(tables);
console.log(
  `[rehearsal] ${before} rows in the database, seeded in ${seeded.ms} ms`,
);

console.log("[rehearsal] exporting");
const exported = wrangler(
  ["d1", "export", "ringbolt", "--local", "--output", DUMP],
  "export",
);
const bytes = statSync(DUMP).size;
console.log(`[rehearsal] exported ${bytes} bytes in ${exported.ms} ms`);

console.log("[rehearsal] destroying every table");
const dropped = sql(
  tables.map((table) => `DROP TABLE IF EXISTS ${table};`).join(" "),
  "drop tables",
);
const emptied = rowCountOrZero(tables);
if (emptied !== 0) throw new Error(`${emptied} rows survived the drop`);
console.log(`[rehearsal] gone in ${dropped.ms} ms`);

console.log("[rehearsal] restoring from the export");
const restored = wrangler(
  ["d1", "execute", "ringbolt", "--local", "--file", DUMP, "-y"],
  "import",
);
const after = rowCount(tables);
console.log(`[rehearsal] restored ${after} rows in ${restored.ms} ms`);

// Compared rather than reported. A restore that comes back short is the failure this rehearses.
if (after !== before) {
  console.error(`[rehearsal] FAILED: ${before} rows before, ${after} after`);
  process.exit(1);
}

console.log(
  `\n[rehearsal] PASSED. ${before} rows, export ${exported.ms} ms, restore ${restored.ms} ms, dump ${bytes} bytes.`,
);
console.log(
  "[rehearsal] the seeded rows are still in the local database; run npm run db:migrate:local on a fresh one to start clean.",
);

/** Zero is the expected answer here, and a missing table is not an error at this point. */
function rowCountOrZero(tables) {
  try {
    return rowCount(tables, true);
  } catch {
    return 0;
  }
}
