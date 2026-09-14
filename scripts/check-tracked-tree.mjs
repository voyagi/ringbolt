#!/usr/bin/env node
// check-tracked-tree.mjs - fail the build if anything outside the shipped tree is tracked in git.
//
// WHY AN ALLOWLIST AND NOT A DENYLIST
// A denylist has to name the things it is keeping out, and this repository is published, so a rule
// naming a directory tells every reader that the directory exists. An allowlist names only what
// ships. It also catches the case a denylist can never reach: a top-level entry nobody thought to
// forbid, because anything not on the list fails by default.
//
// The friction is deliberate. Adding a genuinely new top-level directory means adding it here in
// the same commit, which is one line and one moment of thought about whether it belongs in a
// published repository at all.
//
// A ZERO-FINDING RESULT IS ONLY MEANINGFUL IF THE SCAN ACTUALLY RAN, so this exits 2 (UNKNOWN)
// rather than 0 whenever it cannot reach the repository or enumerate a single tracked file. An
// empty enumeration is a broken scan, never a clean tree.
//
// Usage:
//   node scripts/check-tracked-tree.mjs              check the repository
//   node scripts/check-tracked-tree.mjs --selftest   prove the check still fires
//
// Exit codes: 0 clean, 1 something outside the shipped tree is tracked, 2 the scan could not run.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALLOWED_DIRS = new Set([
  '.github',
  'design',
  'docs',
  'examples',
  'migrations',
  'scripts',
  'src',
  'test',
]);

const ALLOWED_ROOT_FILES = new Set([
  '.browserslistrc',
  '.dependency-cruiser.cjs',
  '.env.example',
  '.gitignore',
  '.gitleaksignore',
  '.jscpd.json',
  '.size-limit.json',
  'COVERAGE.md',
  'LICENSE',
  'README.md',
  'eslint.config.mjs',
  'package-lock.json',
  'package.json',
  'renovate.json',
  'stryker.config.json',
  'tsconfig.json',
  'verify-ship.mjs',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.mutation.config.ts',
  'wrangler.jsonc',
]);

function trackedFiles(cwd) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

// Returns the offending top-level entries, each with one example of what is tracked under it, so
// the failure message points at a real file rather than at a bare directory name.
function violations(files) {
  const offenders = new Map();
  for (const file of files) {
    const slash = file.indexOf('/');
    const entry = slash === -1 ? file : file.slice(0, slash);
    const allowed = slash === -1 ? ALLOWED_ROOT_FILES.has(entry) : ALLOWED_DIRS.has(entry);
    if (allowed) continue;
    if (!offenders.has(entry)) offenders.set(entry, { count: 0, example: file });
    offenders.get(entry).count += 1;
  }
  return offenders;
}

function checkRepo(cwd) {
  let files;
  try {
    files = trackedFiles(cwd);
  } catch (error) {
    return { code: 2, message: `could not list tracked files: ${error.message}` };
  }
  if (files.length === 0) {
    return { code: 2, message: 'git listed zero tracked files, so nothing was actually checked' };
  }
  const offenders = violations(files);
  if (offenders.size === 0) {
    return { code: 0, message: `clean (${files.length} tracked)` };
  }
  const lines = [...offenders].map(
    ([entry, info]) => `  ${entry}  (${info.count} tracked, for example ${info.example})`,
  );
  return {
    code: 1,
    message:
      `${offenders.size} top-level entr${offenders.size === 1 ? 'y is' : 'ies are'} tracked but not part of the shipped tree:\n` +
      `${lines.join('\n')}\n` +
      'Either untrack it (git rm -r --cached <path>) or, if it genuinely ships, add it to the\n' +
      'allowlist in scripts/check-tracked-tree.mjs in the same commit.',
  };
}

// The controls. A gate nobody has watched fail is a gate nobody knows works, and this one is
// cheap to demonstrate: build two throwaway repositories, one clean and one with a stray entry,
// and require the check to disagree about them.
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'tracked-tree-'));
  const cases = [
    { name: 'clean tree passes', extra: null, expect: 0 },
    { name: 'stray top-level directory fails', extra: 'notes/scratch.md', expect: 1 },
    { name: 'stray root file fails', extra: 'TODO.md', expect: 1 },
  ];
  let failures = 0;
  for (const [index, testCase] of cases.entries()) {
    const dir = join(root, `case-${index}`);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // Otherwise git narrates a line-ending warning per file and buries the control results.
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"control"}\n');
    if (testCase.extra) {
      const target = join(dir, testCase.extra);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'x\n');
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const got = checkRepo(dir).code;
    const ok = got === testCase.expect;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${testCase.name} (expected ${testCase.expect}, got ${got})`);
  }
  rmSync(root, { recursive: true, force: true });
  return failures === 0 ? 0 : 1;
}

if (process.argv.includes('--selftest')) {
  const code = selftest();
  console.log(code === 0 ? '[tracked-tree] controls pass' : '[tracked-tree] CONTROLS FAILED');
  process.exit(code);
}

let repoRoot;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch (error) {
  console.error(`[tracked-tree] UNKNOWN: not a git repository (${error.message})`);
  process.exit(2);
}

const result = checkRepo(repoRoot);
if (result.code === 0) {
  console.log(`[tracked-tree] ${result.message}`);
} else if (result.code === 1) {
  console.error(`[tracked-tree] FAIL: ${result.message}`);
} else {
  console.error(`[tracked-tree] UNKNOWN: ${result.message}`);
}
process.exit(result.code);
