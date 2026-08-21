#!/usr/bin/env node
// verify-ship.mjs - the ONE ship-verification command.
//
// A clean claim is this script's output, not a sentence. Every step prints its
// own exit code, the run stops at the first non-zero, and the summary block is
// the only acceptable evidence of "clean at ship".
//
// Why it exists: a pass covers only what it ran on. "vitest green" type-checks
// nothing, changed-files lint is not whole-repo lint, and a scoped check quoted
// as a full pass is how false ship-claims happen. This script runs the FULL
// surface, in order, cheapest-first:
//
//   1. types - tsc --noEmit           (a green test run never proves this)
//   2. tests - the FULL suite         (no --changed, no filters, one-shot run)
//   3. lint  - the WHOLE repo         (never a changed-files subset)
//   4. gate  - the committed floors   (complexity, duplication, boundaries, ...)
//
// `gate` re-runs the type-check inside its own chain; the duplication is
// deliberate - step 1 fails fast on the cheapest honest signal.
//
// Wiring: copy this file to the product repo root and add
//   "verify:ship": "node verify-ship.mjs"
// to package.json scripts. Adapt the STEPS commands to the product's real
// scripts (they must exist - a missing script exits non-zero, which is the
// correct fail-closed behavior). A watch-mode test script will hang this gate:
// `npm test` must be a one-shot run (e.g. `vitest run`, not `vitest`) - and as
// a backstop each step is killed (and FAILS) after STEP_TIMEOUT_MS.
//
// Residual limitations (not fixable here):
//   - On POSIX the kernel truncates a child's exit status to 8 bits, so a tool
//     exiting with an exact multiple of 256 reads as 0 everywhere (any shell,
//     not just this script). No mainstream tool does that.
//   - On Windows a timed-out step's grandchildren (the shell dies, npm/node may
//     not) can linger and keep printing after the FAIL verdict. The verdict is
//     still correct; kill the leftover node process manually if one hangs on.

import { spawnSync } from 'node:child_process';

// Generous by design: it must never fail a legitimately slow FULL suite; it
// only backstops a genuine hang (watch mode, a stuck prompt). Raise per
// product if a real run needs more.
// Overridable via VERIFY_SHIP_TIMEOUT_MS so the backstop is PROVABLE: with a
// hardcoded 30 min the only way to exercise this branch was to edit the file,
// which means nobody ever proved it fires (the Workshop's P1 asks every gate to
// be demonstrated failing). `npx cross-env VERIFY_SHIP_TIMEOUT_MS=4000 npm run
// verify:ship` against a deliberately hung script shows it working in seconds.
// A non-numeric or non-positive value falls back to the default rather than
// disabling the guard - an env typo must not silently remove the backstop.
const timeoutOverride = Number(process.env.VERIFY_SHIP_TIMEOUT_MS);
const STEP_TIMEOUT_MS =
  Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : 30 * 60 * 1000;

const STEPS = [
  { name: 'types', cmd: 'npm run gate:types' }, // tsc --noEmit
  { name: 'tests', cmd: 'npm test' },           // FULL suite, one-shot
  { name: 'lint',  cmd: 'npm run lint' },       // WHOLE-repo lint
  { name: 'gate',  cmd: 'npm run gate' },       // committed gate chain (floors)
];

const results = [];
let failed = null;

for (const step of STEPS) {
  if (failed) {
    results.push({ ...step, status: 'NOT RUN', code: null });
    continue;
  }
  console.log(`\n[verify:ship] running "${step.name}": ${step.cmd}`);
  const r = spawnSync(step.cmd, { shell: true, stdio: 'inherit', timeout: STEP_TIMEOUT_MS });
  let code;
  // Order matters: a timeout kill sets BOTH r.error (ETIMEDOUT) and r.signal,
  // so diagnose it first or the message misreports it as "could not run".
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.error(`[verify:ship] ${step.name} TIMED OUT after ${STEP_TIMEOUT_MS / 60000} min (hung step?) - killed`);
    code = 1;
  } else if (r.error) {
    console.error(`[verify:ship] ${step.name} could not run: ${r.error.message}`);
    code = 1;
  } else if (r.status === null) {
    console.error(`[verify:ship] ${step.name} killed by signal ${r.signal}`);
    code = 1;
  } else {
    code = r.status;
  }
  console.log(`[verify:ship] ${step.name} exited ${code}`);
  const status = code === 0 ? 'PASS' : 'FAIL';
  results.push({ ...step, status, code });
  if (code !== 0) failed = { name: step.name, code };
}

const pad = Math.max(...STEPS.map((s) => s.name.length));
console.log('\n============ verify:ship summary ============');
for (const r of results) {
  const codeStr = r.code === null ? '' : ` (exit ${r.code})`;
  console.log(`  ${r.name.padEnd(pad)}  ${r.status}${codeStr}`);
}
console.log('=============================================');

if (failed) {
  console.log(`verify:ship: FAIL at step "${failed.name}" (exit ${failed.code})`);
  process.exit(failed.code || 1);
}
console.log(`verify:ship: PASS (${STEPS.length}/${STEPS.length} steps green)`);
process.exit(0);
