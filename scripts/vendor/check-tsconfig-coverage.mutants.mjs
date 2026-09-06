#!/usr/bin/env node
// check-tsconfig-coverage.mutants.mjs - prove the gate's --selftest controls are NON-VACUOUS.
//
// Each mutation disables exactly ONE rule of check-tsconfig-coverage.mjs; the gate's own --selftest
// must then go RED, and specifically the control the mutation NAMES must go red. A mutation that
// leaves --selftest green is an ESCAPE: the control named after that rule asserts nothing. The
// reverse direction is checked too: a control no mutation can redden is never examined at all and
// is reported as a gap.
//
// The runner is deliberately the same shape as check-env-example.mutants.mjs. These files are
// copied into product repos ONE AT A TIME, so a shared helper module would be a third file and a
// coupling that breaks whenever only two of the three are copied. The duplication is the cost of
// each gate being independently portable, and it is the estate's existing convention.
//
// RUNTIME. The gate's selftest builds a real git repository per control and resolves each fixture
// with a real TypeScript, so one run is seconds and the full sweep is a few minutes. Mutations run
// CONCURRENTLY, and `--only <substring>` re-proves a single rule after editing it.
//
// TSCONFIG_COVERAGE_TS is inherited by every selftest run. Set it when the repo running this harness
// has no typescript of its own (the Workshop itself, for instance); a product repo never needs it.
//
// Usage:  node scripts/vendor/check-tsconfig-coverage.mutants.mjs [--only <substring>] [--jobs <n>]
// Exit codes: 0 all mutations caught, 1 an escape or an unproven control, 2 the baseline is not green.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'check-tsconfig-coverage.mjs');
// Line endings normalised, because several anchors below span two lines and carry a `\n`. On a
// checkout with core.autocrlf=true, the Windows default, the source arrives with CRLF and not one
// of those anchors could match; the harness would then blame anchor drift for a change nobody
// made. The sibling harness learned this the expensive way on 2026-09-05.
const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// `find` must be a UNIQUE substring of the gate source; `repl` disables that one rule. `expect`
// NAMES the control this mutation must turn red, and it is the point rather than documentation:
// these fixtures share a shape heavily, so a rule whose own control had been deleted would still
// score as caught off a neighbour's control, and the harness would print full coverage for a rule
// nothing tests.
const MUTATIONS = [
  // --- rule 1: every tracked TypeScript file is in some program ---
  { name: 'the uncovered rule fires at all', expect: 'a test folder outside include is a finding', find: "    findings.push({ file: f, kind: 'uncovered', why: 'outside every tsconfig in the repo, so tsc never checks it' });", repl: '    continue;' },
  { name: 'root files are not quietly exempt', expect: 'a root config file outside include is a finding', find: '    if (!twin && isCovered) continue;', repl: "    if (!twin && (isCovered || !f.includes('/'))) continue;" },
  { name: 'every tsconfig contributes, not only the first', expect: 'a second tsconfig covering the file makes it clean', find: '  for (const c of configs) {', repl: '  for (const c of configs.slice(0, 1)) {' },
  // An EMPTY include, not an empty object. `{}` was the first version, and it escaped: a config
  // with no include at all is `**/*` to TypeScript, so that mutation WIDENED coverage and turned
  // the finding controls red while the clean control it named stayed green. `include: []` is the
  // narrowing the name promises: a program with no files in it.
  { name: 'the program is resolved from the config body', expect: 'a fully covered repo passes', find: 'parseJsonConfigFileContent(read.config, ts.sys', repl: 'parseJsonConfigFileContent({ include: [] }, ts.sys' },
  { name: 'extends is resolved rather than dropped', expect: 'an include inherited through extends is respected, not widened to everything', find: 'parseJsonConfigFileContent(read.config, ts.sys', repl: 'parseJsonConfigFileContent({ ...read.config, extends: undefined }, ts.sys' },
  { name: 'declaration files are exempt', expect: 'a declaration file outside include is not demanded', find: 'TS_FILE_RE.test(f) && !DECLARATION_RE.test(f) && !NODE_MODULES_RE.test(f)', repl: 'TS_FILE_RE.test(f) && !NODE_MODULES_RE.test(f)' },
  { name: 'node_modules is exempt', expect: 'a vendored node_modules file is never counted', find: 'TS_FILE_RE.test(f) && !DECLARATION_RE.test(f) && !NODE_MODULES_RE.test(f)', repl: 'TS_FILE_RE.test(f) && !DECLARATION_RE.test(f)' },
  { name: 'a no-TypeScript repo is clean', expect: 'a repo with no TypeScript files needs nothing', find: '  if (tsFiles.length === 0) {\n    return { ok: true, findings, advisories, tracked: 0, configs: configs.length, covered: 0 };\n  }', repl: "  if (tsFiles.length === 0) {\n    return { ok: false, findings: [{ file: 'src/main.js', kind: 'uncovered', why: 'mutated' }], advisories, tracked: 0, configs: configs.length, covered: 0 };\n  }" },

  // --- exemptions ---
  { name: 'the in-file marker is honoured', expect: 'the in-file ignore marker exempts a file', find: '    if (ignoredByFlag(f, ignorePatterns) || hasIgnoreMarker(join(root, f))) continue;', repl: '    if (ignoredByFlag(f, ignorePatterns)) continue;' },
  { name: 'the marker window is five lines, not the whole file', expect: 'the marker only counts in the first five lines', find: 'const MARKER_LINES = 5;', repl: 'const MARKER_LINES = 50;' },
  { name: 'the --ignore glob is honoured', expect: 'an --ignore glob exempts matching paths', find: '  return patterns.some((re) => re.test(rel));', repl: '  return false;' },
  { name: 'a single star stays inside one directory', expect: 'an --ignore glob does not cross directories with a single star', find: "      else re += '[^/]*';", repl: "      else re += '.*';" },

  // --- rule 2: twins ---
  { name: 'a twin is named as a twin, not merely as uncovered', expect: 'a .tsx twin of a .ts is reported as dropped, not merely uncovered', find: '    const twin = twinOf.get(f);', repl: '    const twin = undefined;' },
  { name: 'twins are matched case-insensitively', expect: 'a twin differing only by letter case names the local and CI disagreement', find: "    const key = f.replace(/\\.(ts|tsx)$/i, '').toLowerCase();", repl: "    const key = f.replace(/\\.(ts|tsx)$/i, '');" },

  // --- rule 3: a tsconfig exists ---
  { name: 'the no-tsconfig rule fires', expect: 'tracked TypeScript with no tsconfig at all is a finding', find: '    if (exempt.length !== tsFiles.length) {', repl: '    if (false) {' },
  { name: 'a Deno project is exempt from rule 3', expect: 'a Deno project without a tsconfig is clean, with a note saying why', find: '    if (denoProject) {', repl: '    if (false) {' },

  // --- the advisory, both directions ---
  { name: 'the no-tsc-script advisory is emitted', expect: 'a repo whose scripts never run tsc gets a note, not a finding', find: "      advisories.push('no package.json script runs tsc, so this coverage is of a check nothing executes');", repl: '      ;' },
  { name: 'the advisory reads the scripts rather than always firing', expect: 'a repo with a tsc script gets no such note', find: '    if (scripts && !Object.values(scripts).some((v) => /\\btsc\\b/.test(String(v)))) {', repl: '    if (scripts) {' },

  // --- UNKNOWN is never clean ---
  { name: 'a non-repository is UNKNOWN, never clean', expect: 'a non-repository is UNKNOWN, not clean', find: '    return { unknown: true, reason: `not a git repository at ${cwd}`, findings: [] };', repl: '    return { ok: true, findings: [], advisories: [], tracked: 0, configs: 0, covered: 0 };' },
  { name: 'a missing compiler is UNKNOWN, never clean', expect: 'no resolvable TypeScript is UNKNOWN, not clean', find: '    return { unknown: true, reason: resolved.error, findings: [] };', repl: '    return { ok: true, findings: [], advisories: [], tracked: tsFiles.length, configs: configs.length, covered: 0 };' },
  { name: 'an unreadable tsconfig is UNKNOWN, never skipped', expect: 'an unreadable tsconfig is UNKNOWN, not clean', find: '    if (p.error) return { unknown: true, reason: `tsconfig unreadable, ${p.error}`, findings: [] };', repl: '    if (p.error) continue;' },

  // --- exit codes ---
  { name: 'findings outrank incompleteness in the exit code', expect: 'an INCOMPLETE scan WITH findings exits 1, not 2', find: '    return (res.findings || []).length ? 1 : 2;', repl: '    return 2;' },
  { name: 'an INCOMPLETE scan does not exit 0', expect: 'an INCOMPLETE scan with no findings exits 2', find: '    return (res.findings || []).length ? 1 : 2;', repl: '    return (res.findings || []).length ? 1 : 0;' },
  { name: 'a clean scan exits 0', expect: 'a clean scan exits 0', find: 'file(s) in their programs)`);\n    return 0;', repl: 'file(s) in their programs)`);\n    return 2;' },
  { name: 'a scan with findings exits 1', expect: 'a scan with findings exits 1', find: '  return 1;\n}\n\n// --- selftest', repl: '  return 0;\n}\n\n// --- selftest' },
  { name: 'an unknown flag is refused', expect: 'an unknown flag is refused, not silently ignored', find: '  if (unknownFlags.length) {', repl: '  if (false) {' },
  { name: '--ignore without a glob is refused', expect: '--ignore without a glob is refused', find: "      if (!g || g.startsWith('-')) {", repl: '      if (false) {' },
];

function parseError(file) {
  try { execFileSync(process.execPath, ['--check', file], { windowsHide: true, stdio: 'pipe' }); return null; }
  catch (e) {
    const line = String((e && e.stderr) || '').split('\n').find((l) => /Error/.test(l));
    return (line || 'parse failed').trim();
  }
}

// Returns the exit code AND the output, plus whether the run produced a verdict at all. A KILLED
// run never answered: `e.status` is null for a signal kill, and treating that as non-zero would
// score "we never found out" as "caught".
async function selftestRun(file) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [file, '--selftest'], {
      encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr, noVerdict: null };
  } catch (e) {
    const noVerdict = (e.killed || e.signal) ? (e.signal ? `killed by ${e.signal}` : 'timed out') : null;
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      out: (e.stdout || '') + (e.stderr || ''),
      noVerdict,
    };
  }
}

// Bounded concurrency. Results are collected BY INDEX and printed in list order afterwards, so the
// report stays deterministic however the runs interleave.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// A control line is `  ok  <name>  ::  <measured>`. The name is everything before the FIRST `  ::  `
// and nothing else is interpreted. No parenthetical stripping: the measured detail quotes findings
// back, and findings contain parentheses, so a stripper keyed controls by their whole line and
// reported sound mutations as escapes on the sibling harness.
const CONTROL_SEP = '  ::  ';
const CONTROL_LINE = /^ {2}(ok|FAIL|skip)\s+(.*)$/;
function controlsIn(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = CONTROL_LINE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const idx = m[2].indexOf(CONTROL_SEP);
    map.set((idx === -1 ? m[2] : m[2].slice(0, idx)).trim(), m[1]);
  }
  return map;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt !== -1 ? argv[onlyAt + 1] : null;
  const jobsAt = argv.indexOf('--jobs');
  const jobs = jobsAt !== -1 ? Number(argv[jobsAt + 1]) : Math.max(2, Math.min(6, cpus().length - 2));
  if (onlyAt !== -1 && !only) {
    console.error('[mutants] --only needs a substring to match mutation names against.');
    return 2;
  }

  const base = await selftestRun(SRC);
  if (base.code !== 0) {
    console.error(`[mutants] baseline gate selftest is NOT green (exit ${base.code}); fix the gate first.`);
    console.error(base.out.split('\n').filter((l) => /FAIL|skip/.test(l)).join('\n'));
    return 2;
  }
  const baseControls = controlsIn(base.out);
  const skipped = [...baseControls].filter(([, v]) => v === 'skip').map(([k]) => k);

  // Controls are keyed by NAME, so two controls sharing a name collapse into one and the harness
  // then blames the wrong thing. Refuse the ambiguity rather than reason about which one won.
  const seenNames = new Map();
  for (const line of base.out.split('\n')) {
    const m = CONTROL_LINE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const idx = m[2].indexOf(CONTROL_SEP);
    const name = (idx === -1 ? m[2] : m[2].slice(0, idx)).trim();
    seenNames.set(name, (seenNames.get(name) || 0) + 1);
  }
  const dupes = [...seenNames].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) {
    console.error('[mutants] DUPLICATE control name(s); every control must be uniquely named:');
    for (const d of dupes) console.error(`  - ${d}`);
    return 2;
  }
  const unnamed = MUTATIONS.filter((m) => !m.expect);
  if (unnamed.length) {
    console.error(`[mutants] ${unnamed.length} mutation(s) have no 'expect' control named:`);
    for (const m of unnamed) console.error(`  - ${m.name}`);
    return 2;
  }
  const unknownExpect = MUTATIONS.filter((m) => !baseControls.has(m.expect));
  if (unknownExpect.length) {
    console.error('[mutants] mutation(s) name an expect control that no selftest control matches:');
    for (const m of unknownExpect) console.error(`  - ${m.name}  ->  ${m.expect}`);
    return 2;
  }

  const selected = only ? MUTATIONS.filter((m) => m.name.includes(only) || m.expect.includes(only)) : MUTATIONS;
  if (!selected.length) {
    console.error(`[mutants] --only ${only} matched no mutation.`);
    return 2;
  }

  const dir = mkdtempSync(join(tmpdir(), 'tsconfig-coverage-mut-'));
  const escapes = [];
  const hostLimited = [];
  const malformed = [];
  const unjudged = [];
  const reddened = new Set();
  console.log(`[mutants] ${selected.length} mutation(s), ${jobs} at a time, ${baseControls.size} controls per run.`);
  try {
    const outcomes = await pool(selected, jobs, async (m, i) => {
      const hits = src.split(m.find).length - 1;
      if (hits !== 1) {
        return { m, kind: 'stale', line: `  FAIL     ${m.name}: mutation target found ${hits} time(s), need exactly 1 (harness is stale)` };
      }
      // A DISTINCT FILE PER MUTATION: concurrent workers must never overwrite each other's mutant.
      const f = join(dir, `mutant-${i}.mjs`);
      writeFileSync(f, src.replace(m.find, m.repl));
      const bad = parseError(f);
      if (bad) {
        return { m, kind: 'malformed', line: `  UNPARSEABLE  ${m.name}: the mutated source is not valid JS (${bad}) - rewrite the mutation, the rule is not implicated` };
      }
      const { code, out, noVerdict } = await selftestRun(f);
      if (noVerdict) {
        return { m, kind: 'unjudged', line: `  NO VERDICT   ${m.name}: the run never finished (${noVerdict}), so it proves nothing either way` };
      }
      const controls = controlsIn(out);
      const reds = [...controls].filter(([, v]) => v === 'FAIL').map(([k]) => k);
      // A non-zero exit is NOT proof a control fired: a mutant that throws also exits non-zero
      // having run nothing. And SOME control going red is not proof either, because these fixtures
      // share a shape. The NAMED control must be the one that fails.
      const ran = controls.size;
      const crashed = ran < baseControls.size;
      const named = reds.includes(m.expect);
      const caught = code !== 0 && !crashed && named;
      const why = crashed ? `CRASHED, only ${ran}/${baseControls.size} controls ran`
        : reds.length === 0 ? `exit ${code} but NO control went red`
          : named ? `exit ${code}, red: ${m.expect}${reds.length > 1 ? ` +${reds.length - 1} more` : ''}`
            : `exit ${code} but its OWN control stayed GREEN; red instead: ${reds.join(' | ')}`;
      return { m, kind: caught ? 'caught' : 'escaped', reds, line: `  ${caught ? 'ok     ' : 'ESCAPED'}  ${m.name}  (${why})` };
    });
    for (const o of outcomes) {
      if (o.kind === 'caught') console.log(o.line); else console.error(o.line);
      if (o.kind === 'stale') escapes.push(o.m.name);
      if (o.kind === 'malformed') malformed.push(o.m.name);
      if (o.kind === 'unjudged') unjudged.push(o.m.name);
      if (o.kind === 'escaped') (skipped.includes(o.m.expect) ? hostLimited : escapes).push(o.m.name);
      for (const r of o.reds || []) reddened.add(r);
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }

  // REVERSE COVERAGE. A control that NO mutation can redden is never examined at all. A filtered
  // run cannot make this claim and says so rather than listing dozens of false gaps.
  const gaps = only ? [] : [...baseControls]
    .filter(([name, verdict]) => verdict !== 'skip' && !reddened.has(name))
    .map(([name]) => name);
  if (only) {
    console.error(`[mutants] --only ${only}: reverse-coverage NOT checked. Run the full sweep for that.`);
  }
  if (gaps.length) {
    console.error(`[mutants] ${gaps.length} control(s) NOT PROVEN - no mutation makes them fail:`);
    for (const name of gaps) console.error(`  - ${name}`);
  }
  if (skipped.length) {
    console.error(`[mutants] ${skipped.length} control(s) SKIPPED on this host, so unproven HERE (not a defect):`);
    for (const name of skipped) console.error(`  - ${name}`);
  }
  if (hostLimited.length) {
    console.error(`[mutants] ${hostLimited.length} mutation(s) unjudged here: the control they name skipped:`);
    for (const name of hostLimited) console.error(`  - ${name}`);
  }

  if (malformed.length || unjudged.length) {
    console.error(`[mutants] ${malformed.length} malformed and ${unjudged.length} unjudged mutation(s):`);
    for (const n of malformed) console.error(`  - ${n} (mutation does not parse)`);
    for (const n of unjudged) console.error(`  - ${n} (run never finished)`);
    console.error('[mutants] These asked no question, so the coverage claim below would be a lie.');
    return 1;
  }
  if (escapes.length) {
    console.error(`[mutants] ${escapes.length} mutation(s) ESCAPED - the named control(s) assert nothing.`);
    return 1;
  }
  if (gaps.length) return 1;
  if (skipped.length || hostLimited.length) {
    console.error('[mutants] UNKNOWN: everything this host could judge passed, but the controls above');
    console.error('[mutants] could not run here. Exit 2, not 0 - an unrun control is never a proven one.');
    return 2;
  }
  console.log(`[mutants] all ${selected.length} mutation(s) caught, each reddening the control it NAMES.`);
  if (!only) {
    console.log(`[mutants] all ${baseControls.size} controls proven: every one is reddened by at least one mutation.`);
  }
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e && e.stack || e); process.exit(2); });
