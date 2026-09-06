#!/usr/bin/env node
// check-tsconfig-coverage.mjs - every tracked TypeScript file must sit inside the program of at
// least one tsconfig, so `tsc --noEmit` actually checks it.
//
// WHY THIS EXISTS. Measured 2026-09-06 across every repo on the machine, the day after Covercast
// was found shipping its whole Playwright suite and its three root config files outside
// `include`: twelve live repos had the same gap, from one config file to a 27-file test folder,
// and three more had full coverage of a `tsc` that nothing ever ran. A test that is not
// type-checked hides its own bugs until it fails for the wrong reason, and a config file outside
// the program breaks the build with no compiler in the loop. Nothing mechanical said so anywhere.
//
// THREE RULES AND ONE ADVISORY.
//   1. COVERED. Every tracked .ts, .tsx, .mts and .cts file (not .d.ts, not under node_modules) is
//      in the file set of at least one tracked tsconfig*.json, resolved by the repo's OWN
//      TypeScript exactly as tsc resolves it: include, exclude, files and extends all apply.
//   2. NO TWINS. A .ts and a .tsx with the same name in the same directory. TypeScript keeps the
//      .ts and silently drops the .tsx from the program even when the directory is included.
//      Measured on Covercast: three test files vitest ran and tsc never saw. Names differing only
//      by letter case are twins on Windows and macOS and two files on Linux, so the local check and
//      the CI check disagree, which is its own defect.
//   3. A TSCONFIG EXISTS while TypeScript files are tracked. A tracked deno.json with no tsconfig
//      is a Deno project and is exempt, because Deno type-checks without one.
//   note: no package.json script runs tsc. Coverage of a check nobody runs is reported, never
//      failed: which script owns the check is the product's call, and only its absence is noted.
//
// EXEMPTIONS ARE VISIBLE, NEVER SILENT. A file may carry `// tsconfig-coverage: ignore <reason>`
// in its first five lines, or the script line may pass `--ignore <glob>`, repeatable. Both show up
// where a reader looks: in a diff, or in package.json.
//
// Stack independent and with no dependencies of its own: it borrows the repo's TypeScript, which
// any repo with a tsconfig already has, and reports UNKNOWN rather than clean when it cannot find
// one. Exit codes: 0 clean, 1 findings, 2 UNKNOWN. Findings outrank incompleteness, so an unknown
// scan that still found something exits 1.
//
// Usage:
//   node scripts/vendor/check-tsconfig-coverage.mjs                   check the repo
//   node scripts/vendor/check-tsconfig-coverage.mjs --ignore <glob>   exempt paths, repeatable
//   node scripts/vendor/check-tsconfig-coverage.mjs --selftest        prove the gate still fires
//
// TSCONFIG_COVERAGE_TS is a test-only override: the directory of a `typescript` package to use
// instead of the repo's own. The selftest resolves one for its fixtures; a production run never
// needs it and never reads a fixture.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

// --- what is looked at -------------------------------------------------------------------------

const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/i;
const DECLARATION_RE = /\.d\.(ts|mts|cts)$/i;
const NODE_MODULES_RE = /(^|\/)node_modules\//i;
const TSCONFIG_RE = /(^|\/)tsconfig[^/]*\.json$/i;
const DENO_CONFIG_RE = /^deno\.jsonc?$/i;
const IGNORE_MARKER_RE = /tsconfig-coverage:\s*ignore/i;
const MARKER_LINES = 5;

// --- git helpers -------------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

// `-z` so a path holding a space, a quote or a non-ASCII letter arrives as itself. Without it git
// quotes such paths and the quoted form matches nothing the compiler reports.
function trackedFiles(root) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean);
}

// --- resolving the compiler --------------------------------------------------------------------

// The repo's OWN TypeScript, resolved from inside the repo so hoisted and workspace layouts both
// work. Borrowing the compiler rather than re-implementing tsconfig semantics is the whole design:
// a home-grown `include` matcher would drift from tsc the first time either changed, and the point
// of this gate is to say what tsc will do.

/**
 * The PACKAGE directory of the resolved compiler, the one holding typescript's package.json,
 * because that is what the override branch loads from and what the selftest hands back in as the
 * override. The first version returned the directory of the resolved entry file instead, which is
 * `lib/`: the Workshop proved the selftest through TSCONFIG_COVERAGE_TS, where `from` is the
 * override itself, and the first product repo with its own compiler (ringbolt, 2026-09-06) had 16
 * of 28 controls come back UNKNOWN with "Cannot find module './'". Walks up from the entry file to
 * the nearest package.json that names typescript, so a nested `lib/` layout and a flat one both
 * resolve.
 */
function packageDirOf(entry) {
  let dir = dirname(entry);
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'typescript') return dir;
    } catch {
      /* not this level */
    }
    const parent = dirname(dir);
    if (parent === dir) return dirname(entry);
    dir = parent;
  }
}

/**
 * The four compiler calls programFiles makes, checked before any of them runs. A package that
 * resolves as `typescript` but exposes a different API (a stub, a future major that moves the
 * compiler API off its main entry) must read as UNKNOWN with a reason, not as a TypeError with a
 * stack where the verdict should be.
 */
function usable(ts, from) {
  const required = {
    readConfigFile: ts?.readConfigFile,
    parseJsonConfigFileContent: ts?.parseJsonConfigFileContent,
    'sys.readFile': ts?.sys?.readFile,
    flattenDiagnosticMessageText: ts?.flattenDiagnosticMessageText,
  };
  const missing = [];
  for (const [name, fn] of Object.entries(required)) {
    if (typeof fn !== 'function') missing.push(name);
  }
  if (missing.length) {
    return { error: `the resolved TypeScript ${ts?.version || '(no version)'} exposes no ${missing.join(', ')}` };
  }
  return { ts, from };
}

/** The repo's own compiler and its package directory, or an error naming why there is none. */
function resolveTypescript(root, override) {
  try {
    if (override) return usable(createRequire(join(override, 'package.json'))('./'), override);
    const req = createRequire(join(root, '__tsconfig_coverage_resolve__.js'));
    const entry = req.resolve('typescript');
    return usable(req(entry), packageDirOf(entry));
  } catch (e) {
    return { error: `no TypeScript to resolve configs with (${(e && e.message || '').split('\n')[0]})` };
  }
}

/**
 * The file set of one tsconfig, as tsc would build it. Paths come back absolute with forward
 * slashes; they are made repo-relative and case-folded here so they compare against git's list.
 */
function programFiles(ts, root, configRel) {
  // Forward slashes, because that is the form TypeScript normalises to internally. Handed a
  // backslash path, its config reader asserts on the mismatch the moment it has a diagnostic to
  // attach to the file, so an unreadable tsconfig crashed the scan instead of reporting UNKNOWN.
  // Measured 2026-09-06 in this gate's own selftest, on Windows.
  const abs = join(root, configRel).replace(/\\/g, '/');
  const read = ts.readConfigFile(abs, ts.sys.readFile);
  if (read.error) {
    return { error: `${configRel}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}` };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(abs), undefined, abs);
  // A config tsc would refuse (an `extends` that resolves to nothing, an unknown option) still
  // comes back with a file list, and for a dropped `extends` that list is the implicit `**/*`.
  // Counting it would call files covered that tsc never checks. TS18003, "no inputs were found",
  // is the one diagnostic tolerated: an empty program is still a program.
  const fatal = (parsed.errors || []).filter((d) => d.code !== 18003);
  if (fatal.length) {
    return { error: `${configRel}: ${ts.flattenDiagnosticMessageText(fatal[0].messageText, ' ')}` };
  }
  const files = new Set();
  const rootFwd = root.replace(/\\/g, '/').replace(/\/$/, '');
  for (const f of parsed.fileNames) {
    const fwd = f.replace(/\\/g, '/');
    const rel = fwd.toLowerCase().startsWith(rootFwd.toLowerCase() + '/') ? fwd.slice(rootFwd.length + 1) : fwd;
    files.add(rel.toLowerCase());
  }
  return { files };
}

// --- exemptions --------------------------------------------------------------------------------

/**
 * A deliberately SMALL glob: a double star crosses directories, `*` and `?` do not, everything
 * else is literal. It matches the repo-relative forward-slash path, anchored at both ends. A
 * double star followed by a slash keeps a segment boundary after itself and matches zero or more
 * WHOLE directories: without it an ignore of `generated.ts` under any directory became
 * `.*generated\.ts` and exempted `notgenerated.ts` as well.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
      }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function ignoredByFlag(rel, patterns) {
  return patterns.some((re) => re.test(rel));
}

// Only the first few lines are read, and only of files the gate is about to report, so a large
// repo pays for this once per finding rather than once per file.
function hasIgnoreMarker(abs) {
  let fd;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(2048);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n).split(/\r?\n/).slice(0, MARKER_LINES).join('\n');
    return IGNORE_MARKER_RE.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// --- the scan ----------------------------------------------------------------------------------

function scan(cwd, opts = {}) {
  const ignorePatterns = (opts.ignore || []).map(globToRegExp);
  let root;
  try {
    root = repoRoot(cwd);
  } catch {
    return { unknown: true, reason: `not a git repository at ${cwd}`, findings: [] };
  }
  let tracked;
  try {
    tracked = trackedFiles(root);
  } catch (e) {
    return { unknown: true, reason: `git ls-files failed: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }
  if (tracked.length === 0) {
    return { unknown: true, reason: 'git ls-files returned no tracked files (empty index)', findings: [] };
  }

  const tsFiles = tracked.filter((f) => TS_FILE_RE.test(f) && !DECLARATION_RE.test(f) && !NODE_MODULES_RE.test(f));
  const configs = tracked.filter((f) => TSCONFIG_RE.test(f) && !NODE_MODULES_RE.test(f));
  const denoProject = tracked.some((f) => DENO_CONFIG_RE.test(f));
  const advisories = [];
  const findings = [];

  if (tsFiles.length === 0) {
    return { ok: true, findings, advisories, tracked: 0, configs: configs.length, covered: 0 };
  }

  // Rule 3: a tsconfig exists at all. Deno is the one runtime that type-checks without one.
  if (configs.length === 0) {
    if (denoProject) {
      advisories.push('a Deno project (deno.json tracked, no tsconfig): Deno type-checks these itself, nothing to resolve');
      return { ok: true, findings, advisories, tracked: tsFiles.length, configs: 0, covered: tsFiles.length };
    }
    const exempt = tsFiles.filter((f) => ignoredByFlag(f, ignorePatterns) || hasIgnoreMarker(join(root, f)));
    if (exempt.length !== tsFiles.length) {
      findings.push({
        file: 'tsconfig.json', kind: 'no-tsconfig',
        why: `${tsFiles.length - exempt.length} TypeScript file(s) are tracked and no tsconfig exists, so nothing can type-check them`,
      });
    }
    return finish(root, findings, advisories, tsFiles.length, 0, 0, tracked);
  }

  // Rule 1: the union of every tsconfig's program, resolved by the repo's own compiler.
  const resolved = resolveTypescript(root, opts.tsDir || process.env.TSCONFIG_COVERAGE_TS || undefined);
  if (resolved.error) {
    return { unknown: true, reason: resolved.error, findings: [] };
  }
  const covered = new Set();
  for (const c of configs) {
    const p = programFiles(resolved.ts, root, c);
    if (p.error) return { unknown: true, reason: `tsconfig unreadable, ${p.error}`, findings: [] };
    for (const f of p.files) covered.add(f);
  }

  // Rule 2: twins. Grouped by directory plus case-folded stem, exactly the key TypeScript's
  // extension-priority rule and a case-insensitive file system both use.
  const twinOf = new Map();
  const groups = new Map();
  for (const f of tsFiles) {
    if (!/\.(ts|tsx)$/i.test(f)) continue;
    const key = f.replace(/\.(ts|tsx)$/i, '').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const group of groups.values()) {
    const tsx = group.filter((f) => /\.tsx$/i.test(f));
    const plain = group.filter((f) => /\.ts$/i.test(f));
    if (!tsx.length || !plain.length) continue;
    for (const dropped of tsx) {
      const keeper = plain[0];
      const sameCase = basename(keeper).replace(/\.ts$/i, '') === basename(dropped).replace(/\.tsx$/i, '');
      twinOf.set(dropped, { keeper, sameCase });
    }
  }

  for (const f of tsFiles) {
    const twin = twinOf.get(f);
    const isCovered = covered.has(f.replace(/\\/g, '/').toLowerCase());
    if (!twin && isCovered) continue;
    if (ignoredByFlag(f, ignorePatterns) || hasIgnoreMarker(join(root, f))) continue;
    if (twin) {
      findings.push({
        file: f, kind: 'twin',
        why: twin.sameCase
          ? `shares its name with ${twin.keeper}, and tsc keeps the .ts and drops this .tsx from the program`
          : `shares its name with ${twin.keeper} except for letter case: dropped by tsc on Windows and macOS, checked on Linux, so local and CI disagree`,
      });
      continue;
    }
    findings.push({ file: f, kind: 'uncovered', why: 'outside every tsconfig in the repo, so tsc never checks it' });
  }

  return finish(root, findings, advisories, tsFiles.length, configs.length, covered.size, tracked);
}

// The advisory is computed on every complete scan, clean or not, because it is about the repo and
// not about the findings.
function finish(root, findings, advisories, trackedCount, configCount, coveredCount, tracked) {
  if (tracked.includes('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts || {}; } catch { scripts = null; }
    if (scripts && !Object.values(scripts).some((v) => /\btsc\b/.test(String(v)))) {
      advisories.push('no package.json script runs tsc, so this coverage is of a check nothing executes');
    }
  }
  return { ok: findings.length === 0, findings, advisories, tracked: trackedCount, configs: configCount, covered: coveredCount };
}

// --- reporting ---------------------------------------------------------------------------------

function report(res) {
  if (res.unknown) {
    console.error(`[tsconfig-coverage] INCOMPLETE: ${res.reason}`);
    console.error('[tsconfig-coverage] Refusing to report clean on a scan that did not run.');
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return (res.findings || []).length ? 1 : 2;
  }
  for (const a of res.advisories || []) console.log(`[tsconfig-coverage] note: ${a}`);
  if (res.ok) {
    console.log(`[tsconfig-coverage] clean (${res.tracked} TypeScript file(s) tracked, ${res.configs} tsconfig(s), ${res.covered} file(s) in their programs)`);
    return 0;
  }
  console.error(`[tsconfig-coverage] ${res.findings.length} finding(s):`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  if (res.findings.some((f) => f.kind === 'uncovered')) {
    console.error('');
    console.error('OUTSIDE EVERY TSCONFIG: add its folder to `include` (or a `*.config.ts` glob for root');
    console.error('config files), or give it a tsconfig of its own. If it genuinely must stay out, say so');
    console.error('where a reader sees it: `// tsconfig-coverage: ignore <reason>` in its first lines, or');
    console.error('`--ignore <glob>` on the script line in package.json.');
  }
  if (res.findings.some((f) => f.kind === 'twin')) {
    console.error('');
    console.error('A TWIN is a rename, not a config change. Two files whose names differ only in .ts');
    console.error('against .tsx (or only in letter case) are one name to TypeScript, and it keeps the .ts.');
  }
  if (res.findings.some((f) => f.kind === 'no-tsconfig')) {
    console.error('');
    console.error('NO TSCONFIG: add one with an `include` that names every folder holding TypeScript, and');
    console.error('a script that runs `tsc --noEmit`. A Deno project needs a tracked deno.json instead.');
  }
  return 1;
}

// --- selftest ----------------------------------------------------------------------------------
//
// EVERY RULE GETS ITS OWN ISOLATED CONTROL, and each fixture is built so exactly one rule can fire.
// No commits anywhere: everything the gate reads about tracking comes from `git ls-files`, which
// reads the index, so staging alone builds every state these controls need.

function fixture(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tsconfig-coverage-st-'));
  git(['init', '-q'], root);
  const noExcludes = join(root, '.git', 'empty-excludes');
  writeFileSync(noExcludes, '');
  appendFileSync(join(root, '.git', 'config'), `\n[core]\n\texcludesFile = ${noExcludes.replace(/\\/g, '/')}\n\tautocrlf = false\n`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(['add', '-A'], root);
  for (const f of opts.force || []) git(['add', '-f', '--', f], root);
  const staged = new Set(git(['ls-files'], root).trim().split('\n').filter(Boolean));
  const gap = Object.keys(files).filter((f) => !staged.has(f));
  if (gap.length) throw new Error(`fixture failed to stage ${gap.join(', ')} - this case would assert nothing`);
  return root;
}

function muted(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

const TSCONFIG_SRC = '{ "compilerOptions": { "strict": true, "noEmit": true, "jsx": "react-jsx" }, "include": ["src"] }\n';
const SRC_FILE = 'export const one: number = 1;\n';

/** One isolated control per rule, each in a real git repository. Returns the exit code. */
function selftest() {
  // The fixtures have no node_modules, so the compiler comes from wherever this selftest runs,
  // or from the override. A host with neither cannot judge these controls and says so per line.
  const host = resolveTypescript(process.cwd(), process.env.TSCONFIG_COVERAGE_TS || undefined);
  const SEP = '  ::  ';
  let failures = 0;
  const emit = (ok, name, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok     ' : 'FAIL   '} ${name}${SEP}${detail}`);
  };

  const cases = [];
  const base = { 'tsconfig.json': TSCONFIG_SRC, 'src/index.ts': SRC_FILE };

  // NEGATIVE control: a correct repo must pass, or nothing else here means anything.
  cases.push({ name: 'a fully covered repo passes', files: base, expect: 'clean' });
  cases.push({ name: 'a repo with no TypeScript files needs nothing', files: { 'src/main.js': 'export const x = 1;\n' }, expect: 'clean' });

  // Rule 1, in the three shapes measured on real repos.
  cases.push({
    name: 'a test folder outside include is a finding',
    files: { ...base, 'e2e/app.spec.ts': SRC_FILE },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside every tsconfig/,
  });
  cases.push({
    name: 'a root config file outside include is a finding',
    files: { ...base, 'vitest.config.ts': SRC_FILE },
    expect: 'fail', expectWhy: /vitest\.config\.ts <- outside every tsconfig/,
  });
  cases.push({
    name: 'a file the tsconfig EXCLUDES is a finding too',
    files: { ...base, 'tsconfig.json': TSCONFIG_SRC.replace('"include": ["src"]', '"include": ["src"], "exclude": ["**/*.test.ts"]'), 'src/a.test.ts': SRC_FILE },
    expect: 'fail', expectWhy: /src\/a\.test\.ts <- outside every tsconfig/,
  });
  cases.push({
    name: 'a second tsconfig covering the file makes it clean',
    files: { ...base, 'tsconfig.test.json': TSCONFIG_SRC.replace('["src"]', '["tests"]'), 'tests/a.test.ts': SRC_FILE },
    expect: 'clean',
  });
  // The base lives under a name TSCONFIG_RE does not match, so the ONLY route to its include is
  // through `extends`. A first version named it tsconfig.base.json, which the gate parsed on its
  // own, so the control passed whether extends worked or not, and the mutation harness said so.
  // It asserts the negative space on purpose: an `extends` that were silently dropped would leave
  // the child with no include at all, which TypeScript reads as `**/*`, and e2e would be covered.
  cases.push({
    name: 'an include inherited through extends is respected, not widened to everything',
    files: {
      'config/base.json': TSCONFIG_SRC.replace('["src"]', '["../src"]'),
      'tsconfig.json': '{ "extends": "./config/base.json" }\n',
      'src/index.ts': SRC_FILE,
      'e2e/app.spec.ts': SRC_FILE,
    },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside/, forbidWhy: /src\/index\.ts/,
  });
  cases.push({
    name: 'a declaration file outside include is not demanded',
    files: { ...base, 'types/globals.d.ts': 'declare const FLAG: boolean;\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'a vendored node_modules file is never counted',
    files: { ...base, 'node_modules/vendored/index.ts': SRC_FILE },
    force: ['node_modules/vendored/index.ts'],
    expect: 'clean',
  });

  // Exemptions, both kinds, each visible.
  cases.push({
    name: 'the in-file ignore marker exempts a file',
    files: { ...base, 'e2e/app.spec.ts': '// tsconfig-coverage: ignore (Playwright runs it under its own config)\n' + SRC_FILE },
    expect: 'clean',
  });
  cases.push({
    name: 'the marker only counts in the first five lines',
    files: { ...base, 'e2e/app.spec.ts': '\n\n\n\n\n// tsconfig-coverage: ignore too late\n' + SRC_FILE },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside/,
  });
  cases.push({
    name: 'an --ignore glob exempts matching paths',
    files: { ...base, 'supabase/functions/hello/index.ts': SRC_FILE },
    ignore: ['supabase/**'],
    expect: 'clean',
  });
  cases.push({
    name: 'an --ignore glob does not cross directories with a single star',
    files: { ...base, 'supabase/functions/hello/index.ts': SRC_FILE },
    ignore: ['supabase/*'],
    expect: 'fail', expectWhy: /supabase\/functions\/hello\/index\.ts <- outside/,
  });
  cases.push({
    name: 'a globstar followed by a slash keeps the path boundary',
    files: { ...base, 'e2e/generated.ts': SRC_FILE, 'e2e/notgenerated.ts': SRC_FILE },
    ignore: ['**/generated.ts'],
    expect: 'fail', expectWhy: /e2e\/notgenerated\.ts <- outside/, forbidWhy: /e2e\/generated\.ts/,
  });

  // Rule 2, both twin shapes.
  cases.push({
    name: 'a .tsx twin of a .ts is reported as dropped, not merely uncovered',
    files: { ...base, 'src/Card.test.ts': SRC_FILE, 'src/Card.test.tsx': SRC_FILE },
    expect: 'fail', expectWhy: /src\/Card\.test\.tsx <- shares its name with src\/Card\.test\.ts, and tsc keeps the \.ts/,
  });
  cases.push({
    name: 'a twin differing only by letter case names the local and CI disagreement',
    files: { ...base, 'src/grid.test.ts': SRC_FILE, 'src/Grid.test.tsx': SRC_FILE },
    expect: 'fail', expectWhy: /src\/Grid\.test\.tsx <- shares its name with src\/grid\.test\.ts except for letter case/,
  });

  // Rule 3.
  cases.push({
    name: 'tracked TypeScript with no tsconfig at all is a finding',
    files: { 'src/index.ts': SRC_FILE },
    expect: 'fail', expectWhy: /no tsconfig exists/,
  });
  cases.push({
    name: 'a Deno project without a tsconfig is clean, with a note saying why',
    files: { 'deno.json': '{}\n', 'src/index.ts': SRC_FILE },
    expect: 'clean', expectNote: /a Deno project/,
  });

  // The advisory, and its absence when a script does run tsc.
  cases.push({
    name: 'a repo whose scripts never run tsc gets a note, not a finding',
    files: { ...base, 'package.json': '{ "scripts": { "build": "vite build" } }\n' },
    expect: 'clean', expectNote: /no package\.json script runs tsc/,
  });
  cases.push({
    name: 'a repo with a tsc script gets no such note',
    files: { ...base, 'package.json': '{ "scripts": { "typecheck": "tsc --noEmit" } }\n' },
    expect: 'clean', forbidNote: /runs tsc/,
  });

  // UNKNOWN, never clean.
  cases.push({ name: 'a non-repository is UNKNOWN, not clean', noRepo: true, expect: 'unknown' });
  cases.push({
    name: 'no resolvable TypeScript is UNKNOWN, not clean',
    files: base, noCompiler: true,
    expect: 'unknown',
  });
  cases.push({
    name: 'an unreadable tsconfig is UNKNOWN, not clean',
    files: { 'tsconfig.json': '{ this is not json\n', 'src/index.ts': SRC_FILE },
    expect: 'unknown',
  });
  // include names src and src/index.ts exists, so without the diagnostic check this would be clean.
  cases.push({
    name: 'a tsconfig whose extends target is missing is UNKNOWN, not clean',
    files: { 'tsconfig.json': '{ "extends": "./config/missing.json", "include": ["src"] }\n', 'src/index.ts': SRC_FILE },
    expect: 'unknown',
  });
  // A package that resolves as `typescript` and carries none of the compiler API.
  cases.push({
    name: 'a typescript package without the compiler API is UNKNOWN, not clean',
    files: { ...base, 'stub-ts/package.json': '{ "name": "typescript", "version": "0.0.0-stub", "main": "index.js" }\n', 'stub-ts/index.js': 'module.exports = { version: "0.0.0-stub" };\n' },
    stubCompiler: 'stub-ts',
    expect: 'unknown',
  });

  // Exit-code mapping, asserted on report() with hand-built verdicts.
  cases.push({ name: 'a clean scan exits 0', exitFor: { ok: true, findings: [], advisories: [], tracked: 1, configs: 1, covered: 1 }, expectExit: 0 });
  cases.push({ name: 'a scan with findings exits 1', exitFor: { ok: false, findings: [{ file: 'x.ts', kind: 'uncovered', why: 'x' }], advisories: [] }, expectExit: 1 });
  cases.push({ name: 'an INCOMPLETE scan with no findings exits 2', exitFor: { unknown: true, reason: 'x', findings: [] }, expectExit: 2 });
  cases.push({ name: 'an INCOMPLETE scan WITH findings exits 1, not 2', exitFor: { unknown: true, reason: 'x', findings: [{ file: 'x.ts', kind: 'uncovered', why: 'x' }] }, expectExit: 1 });
  cases.push({ name: 'an unknown flag is refused, not silently ignored', files: base, mainArgv: ['node', 'gate', '--fix'], expectExit: 2 });
  cases.push({ name: '--ignore without a glob is refused', files: base, mainArgv: ['node', 'gate', '--ignore'], expectExit: 2 });

  if (host.error) {
    for (const c of cases) console.log(`  skip    ${c.name}${SEP}no TypeScript on this host to resolve fixtures with`);
    console.log(`[tsconfig-coverage] selftest: 0/${cases.length} controls could run (${host.error})`);
    return 2;
  }

  const roots = [];
  /** Builds one control's fixture, runs the scan or report against it, and emits the verdict. */
  function runCase(c) {
    if (c.exitFor) {
      const code = muted(() => report(c.exitFor));
      emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
      return;
    }
    let root;
    let res;
    if (c.mainArgv) {
      root = fixture(c.files, { force: c.force });
      roots.push(root);
      const cwd = process.cwd();
      let code;
      try {
        process.chdir(root);
        code = muted(() => main(c.mainArgv, { tsDir: host.from }));
      } finally {
        process.chdir(cwd);
      }
      emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
      return;
    }
    if (c.noRepo) {
      root = mkdtempSync(join(tmpdir(), 'tsconfig-coverage-norepo-'));
      roots.push(root);
      res = scan(root, { tsDir: host.from });
    } else {
      root = fixture(c.files, { force: c.force });
      roots.push(root);
      // The no-compiler control hands the scan a directory that holds no TypeScript package, rather
      // than nothing at all: given nothing, the scan would fall back to the environment override or
      // walk up from the temp directory, and either could find a real compiler and turn UNKNOWN
      // into clean on the one host where that matters least, the developer's own.
      const tsDir = c.noCompiler ? join(root, 'no-typescript-here') : c.stubCompiler ? join(root, c.stubCompiler) : host.from;
      res = scan(root, { ignore: c.ignore, tsDir });
    }
    const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
    const whys = (res.findings || []).map((f) => `${f.file} <- ${f.why}`).join(' | ');
    const notes = (res.advisories || []).join(' | ');
    let ok = got === c.expect;
    let detail = `expected ${c.expect}, got ${got}${res.unknown ? ` (${res.reason})` : ''}`;
    if (ok && c.expectWhy && !c.expectWhy.test(whys)) { ok = false; detail = `expected a finding matching ${c.expectWhy}, got: ${whys || '(none)'}`; }
    if (ok && c.forbidWhy && c.forbidWhy.test(whys)) { ok = false; detail = `produced a finding matching ${c.forbidWhy}, which this case forbids: ${whys}`; }
    if (ok && c.expectNote && !c.expectNote.test(notes)) { ok = false; detail = `expected a note matching ${c.expectNote}, got: ${notes || '(none)'}`; }
    if (ok && c.forbidNote && c.forbidNote.test(notes)) { ok = false; detail = `produced a note matching ${c.forbidNote}, which this case forbids: ${notes}`; }
    emit(ok, c.name, detail);
  }

  try {
    for (const c of cases) {
      try {
        runCase(c);
      } catch (e) {
        emit(false, c.name, `fixture or run threw: ${(e && e.message) || e}`);
      }
    }
  } finally {
    for (const r of roots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    }
  }
  console.log(`[tsconfig-coverage] selftest: ${cases.length - failures}/${cases.length} controls passed`);
  return failures === 0 ? 0 : 1;
}

// --- entry point -------------------------------------------------------------------------------

/** Parses the flags, refuses unknown ones, and dispatches. Returns the exit code. */
function main(argv, opts = {}) {
  const args = argv.slice(2);
  const ignore = [];
  const unknownFlags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--selftest') continue;
    if (a === '--ignore') {
      const g = args[i + 1];
      if (!g || g.startsWith('-')) {
        console.error('[tsconfig-coverage] --ignore needs a glob, for example --ignore supabase/**');
        return 2;
      }
      ignore.push(g);
      i++;
      continue;
    }
    if (a.startsWith('-')) unknownFlags.push(a);
  }
  // An unrecognised flag is never silently ignored: `--fix` would otherwise run a plain check and
  // print clean on a repo the operator believes it changed.
  if (unknownFlags.length) {
    console.error(`[tsconfig-coverage] unknown flag(s): ${unknownFlags.join(', ')}`);
    console.error('[tsconfig-coverage] usage: check-tsconfig-coverage.mjs [--ignore <glob>]... | --selftest');
    return 2;
  }
  if (args.includes('--selftest')) return selftest();
  return report(scan(process.cwd(), { ignore, tsDir: opts.tsDir }));
}

// No filename guard around this, on purpose: the mutants harness copies this file to
// `mutant-<n>.mjs` and runs it, and a guard keyed on this file's own name would make every mutant
// exit without running a single control, which the harness would then score as a crash.
// exitCode rather than exit(): the harness reads this process through a pipe, and exit() can cut
// off queued stdout before the last control lines reach it.
process.exitCode = main(process.argv);
