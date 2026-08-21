#!/usr/bin/env node
// check-ship-artifacts.mjs - fail the build if AI-process artifacts are TRACKED in git.
//
// WHY THIS EXISTS
// The ship rules lived only as prose in two prompt files, and prose cannot fail a build.
// Three repos shipped leaking pipeline reports on their DEFAULT branch AFTER an equally
// emphatic wording was already in place, and nothing could tell "the untrack step ran and
// matched nothing" apart from "the untrack step never ran".
//
// TWO INDEPENDENT CHECKS, because a filename list can never be exhaustive:
//   1. PATH    - known artifact paths must not be tracked.
//   2. CONTENT - no tracked file may carry pipeline vocabulary, wherever it lives and whatever
//      it is called. This is what catches the report nobody thought to name.
//
// A ZERO-FINDING RESULT IS ONLY MEANINGFUL IF THE SCAN ACTUALLY RAN, so this exits 2 (UNKNOWN)
// rather than 0 whenever it could not enumerate, could not reach the repo root, or could not
// read a file it was supposed to inspect.
//
// Usage:
//   node scripts/check-ship-artifacts.mjs            check the whole repo
//   node scripts/check-ship-artifacts.mjs --selftest prove the gate still fires (controls)
//
// Exit codes: 0 clean, 1 artifacts found, 2 the scan could not run.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PATHS = [
  '.claude/', '.planning/', '.crash-buffers/', '.codex/', '.agents/',
  'CLAUDE.md', 'AGENTS.md',
  'FINAL-REPORT.md', 'ATTACK-REPORT.md', 'REFINE-REPORT.md', 'FORENSICS-REPORT.md',
  'VERIFICATION.md',        // ROOT only; a nested one is judged by CONTENT below
  'HUMAN-TODO.md',          // carries absolute machine paths (home-path leak)
  'docs/BUILD-SPEC.md',     // pass 1 commits it deliberately; it comes out before shipping
];

// The pass number can hide in the DIRECTORY name, where a filename list cannot reach it.
//
// Read the failure log below before touching this, because every previous version was wrong in
// BOTH directions and each one looked principled at the time. (The log is numbered; the CURRENT
// version deliberately is not. That count was written as FIFTH here, SIXTH further down and
// "the seventh" in README.md, all at the same time, so the number tracked nothing.)
//
//   v1  bare `[a-z0-9._-]*pass-\d+`      matched `src/multipass-3/`, `src/bypass-2/`
//   v2  single separated prefix          matched `src/render-pass-1/`, missed `refine-final-pass-4/`
//   v3  a list of the pipeline's names   missed `verify/a11y/taste/design-pass-N`,
//                                        flagged `src/final-pass-2`, `src/build-pass-1`
//   v4  anchored on `artifacts/`         scored ZERO against watt-to-fly's 125 tracked
//                                        `design/refine-pass-4/` files, and flagged
//                                        `vendor/artifacts/x-pass-2/`
//
//   v5  a list of SOURCE extensions      flagged `shaders/render-pass-1/*.glsl`,
//                                        `*.wgsl/.hlsl/.metal/.proto/.tf/.mts`, CSS-module dirs
//                                        (7 of 7 measured), and ONE `viewer.js` silenced a
//                                        directory of 120 leaking screenshots
//
// Every one of those failures was the same mistake: GUESSING AN OPEN-ENDED SET. v3 guessed the
// pass names, v4 guessed the parent, v5 guessed the languages. There is always one more language,
// and a source-root allowlist only relocates the guess onto every framework's layout.
//
// So enumerate the set this gate actually OWNS. It does not own "every programming language"; it
// owns what its own pipeline emits into a pass directory - screenshots, reports, traces, logs.
// That set is closed and short, so `STRONG_OUTPUT_EXT_RE` below lists it and nothing else can
// raise a finding. Being wrong now costs a MISSED exotic report format, not an instruction to
// delete somebody's shaders.
//
// The judgement is per directory, on POSITIVE EVIDENCE ONLY, against a floor. The name list
// survives as a second signal for trees that are third-party by definition, and it applies only
// ABOVE the pass directory.
//
// (Two claims stood here until 2026-07-27 and were wrong by then: that the decision was "by
// MAJORITY", which the floor replaced, and that `OUTPUT_EXT_RE` was the list, which no longer
// exists. An estate count sat here too, taken before the rule changed shape, so it described a
// version that had already been replaced. Counts belong with a dated run, not in a rule comment.)
//
// The trailing hyphen inside the optional group is load-bearing: it keeps `bypass-2`,
// `multipass-3` and `compass-3` out, because those merely CONTAIN "pass" with no separator. The
// group allows inner hyphens so `refine-final-pass-4` still matches.
const PASS_DIR_SEGMENT_RE = /^(?:[a-z0-9._-]+-)?pass-\d+$/i;
const SOURCE_ROOT_NAME_RE = /^(?:src|lib|libs|test|tests|spec|specs|vendor|node_modules|third_party|deps)$/i;

// THE LIST IS INVERTED ON PURPOSE, and this is the correction that matters most here.
//
// The previous version listed SOURCE extensions and treated everything else as output. That is an
// unbounded guess - "name every language" - and it failed the same way the name lists did: review
// measured 7 of 7 real code layouts FLAGGED with a "git rm -r --cached" remedy because their
// extensions were simply absent (`.glsl`, `.wgsl`, `.hlsl`, `.metal`, `.proto`, `.tf`, `.mts`,
// CSS-module-only component dirs). There will always be one more language.
//
// Every version before this one picked a different discriminator - the pass names, the parent
// directory, the source languages, then the output languages - and each was wrong in BOTH
// directions, because they shared one property: a false positive is an instruction to DELETE
// PRODUCT CODE, so every narrowing to stop that created a miss, and every widening to close the
// miss deleted code again. What changed here is the SHAPE of the decision rather than the guess
// inside it. (Deliberately unnumbered: the count was written three different ways across three
// files and every one of them went stale.)
//
// What review measured on the version this replaces, reproduced with controls: the output list
// counted `md|json|ya?ml|svg|html?|xml|csv|txt` as pipeline output, but those are the furniture
// EVERY directory carries, and the majority test flagged on an exact TIE. So
// `shaders/render-pass-1/{frag.glsl, README.md}` was FLAGGED with an untrack remedy, and 9 of the
// 10 leave-alone fixtures below flipped to FLAGGED the moment one ordinary README was added. It
// failed the other way at the same time: an UNRECOGNISED extension counted as non-output and
// voted AGAINST a finding, so `artifacts/refine-pass-4/` holding 3 real screenshots plus 4
// `.jsonl` traces reported CLEAN.
//
// So this version stops trying to classify everything. Only UNAMBIGUOUS artifacts can produce a
// finding; the furniture ABSTAINS; and an extension nobody listed abstains too, lowering
// CONFIDENCE rather than voting.
//
// CONFIDENCE IS NOT A LICENCE TO DELETE. That correction came later, on 2026-07-27, after the
// grade was briefly documented as the one "you can untrack": `confident` says every file is a
// format this gate RECOGNISES, which is not that a pipeline EMITTED it, and no content test can
// separate those - a directory of product JPGs scores it exactly as a screenshot dump does. So
// report() asks the operator to confirm on BOTH grades. The grades say how much was unrecognised;
// they do not authorise a deletion.
//
// Formats that are essentially never hand-written source in a repository. This is the ONLY
// evidence that can raise a finding, so keep it strictly to things a build step emits.
const STRONG_OUTPUT_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|mp4|webm|mov|har|trace|sarif|log|ndjson|jsonl|zip|gz|tgz)$/i;

// The furniture: files that appear in pipeline output and in ordinary source directories alike.
// They ABSTAIN. Counting them as output is precisely what flagged every code directory carrying
// a README; counting them as source is what let one stray file silence a real leak.
const NEUTRAL_EXT_RE = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|svg|html?|xml|lock)$/i;

// A floor, because a single stray screenshot is not a pipeline pass. Three is the smallest count
// that distinguishes "this directory IS the output" from "this directory contains an image".
const PASS_DIR_MIN_OUTPUT = 3;

// Decided PER DIRECTORY, because "is this directory pipeline output" cannot be answered from one
// path. Returns the set of tracked files sitting in a genuine pass directory.
function passDirectoryFiles(files) {
  const byDir = new Map();
  for (const raw of files) {
    const norm = raw.replace(/\\/g, '/');
    const segs = norm.split('/');
    const base = segs.pop();
    const idx = segs.findIndex((s) => PASS_DIR_SEGMENT_RE.test(s));
    if (idx === -1) continue;
    // A source-root name counts only ABOVE the pass directory. Below it, `spec/` or `lib/` is just
    // a folder the pipeline chose, and testing the whole path let `design/refine-pass-4/spec/*.png`
    // exonerate itself - measured at 0 findings where 2 were correct.
    if (segs.slice(0, idx).some((s) => SOURCE_ROOT_NAME_RE.test(s))) continue;
    // Key on the INNERMOST pass segment. Keying on the outermost merged nested pass directories
    // into one bucket, so they exonerated each other.
    const lastIdx = segs.map((s) => PASS_DIR_SEGMENT_RE.test(s)).lastIndexOf(true);
    const key = segs.slice(0, lastIdx + 1).join('/');
    let e = byDir.get(key);
    if (!e) { e = { files: [], strong: 0, unrecognised: 0 }; byDir.set(key, e); }
    e.files.push(norm);
    if (STRONG_OUTPUT_EXT_RE.test(base)) e.strong++;
    else if (!NEUTRAL_EXT_RE.test(base)) e.unrecognised++;
  }
  // POSITIVE EVIDENCE ONLY. No file CONTENT suppresses a finding any more, so the "one stray
  // viewer.js silenced 120 screenshots" failure cannot come back; and nothing but a real artifact
  // can raise one, so a README cannot turn a shader directory into a delete instruction.
  //
  // Said precisely, because the earlier wording here was "Nothing suppresses a finding any more"
  // and review was right that this is flatly false: the source-root name check a dozen lines above
  // suppresses whole subtrees, and it is the reason `src/design/refine-pass-4/` holding twelve
  // screenshots reports CLEAN while `design/refine-pass-4/` is caught (measured 2026-07-27). That
  // exemption is a KNOWN MISS, left in deliberately. Narrowing it to genuinely third-party names
  // would close it and would WIDEN detection into the product's own `src/` and `test/` trees,
  // which is the direction that deletes files, so it waits for the same redesign as the confidence
  // grade rather than being tightened on its own.
  //
  // CONFIDENT means every file here is a format this gate RECOGNISES. It does NOT mean a pipeline
  // produced them, and report() no longer tells anyone to untrack on the strength of it. An
  // unrecognised extension does NOT veto the finding (that was the miss) and does NOT vote for it
  // either (that was the over-delete): it downgrades the grade, which is the honest thing to say
  // about a directory holding something the gate has never heard of.
  const flagged = new Map();
  for (const e of byDir.values()) {
    if (e.strong < PASS_DIR_MIN_OUTPUT) continue;
    const confident = e.unrecognised === 0;
    // NAME ONLY THE ARTIFACTS, in both grades. The furniture ABSTAINED from the decision, so
    // listing it as a finding contradicts the abstention that let the directory be judged at all:
    // measured, `packages/icons-pass-1/` holding three icons put package.json and README.md in a
    // report whose remedy was "untrack". A confident directory used to be named as a unit on the
    // reasoning that it ships as one, which is true of a screenshot dump and false of any product
    // directory that happens to match the name shape. The verdict is unchanged either way; only
    // the file list narrows, so this can never hide a directory that would otherwise be found.
    for (const f of e.files) {
      if (STRONG_OUTPUT_EXT_RE.test(f.slice(f.lastIndexOf('/') + 1))) {
        flagged.set(f, { confident });
      }
    }
  }
  return flagged;
}

// Markers are assembled from fragments so this file cannot match its own rules.
//
// HONEST ACCOUNTING OF WHICH LAYER ACTUALLY PROTECTS IT, because the previous comment here
// claimed the fragments did and that was wrong: the file is a `.mjs`, so it is not content
// scanned at all, and THAT is what keeps it clean today. Review proved the point by finding two
// literal examples still sitting in these comments while the selftest passed. The fragments are
// the second layer, and they matter if the extension allowlist ever widens.
//
// A previous version of this comment claimed that widening the allowlist turns the
// self-reference control red. Review mutated exactly that and it did NOT: that control can only
// fail via the PATH rules, because a `.mjs` is never content scanned however the allowlist
// moves. So layer B was real but UNOBSERVABLE, which is how two literal examples sat in these
// comments while the suite stayed green.
//
// It is observable now. The selftest applies these markers directly to this file's own source
// and to the mutants harness, so a literal example written into a comment fails the suite even
// though the gate's own scan would still pass. Both layers are now checked, independently.
const PASS = 'pa' + 'ss';
const SIGNOFF = 'SIGN' + '-OFF';

const CONTENT_MARKERS = [
  // Bare, parenthesised and slash forms. The parenthesised one is what the pipeline emits in a
  // VERIFICATION heading, and the first version missed it by requiring a digit straight after
  // the word.
  { re: new RegExp(`\\b${PASS}\\s*\\(?\\s*\\d+\\s*(?:of|/)\\s*\\d+`, 'i'), what: 'pass numbering' },
  // The human-readable label is assembled too: spelled out, it would match its own rule.
  { re: new RegExp(`\\b${SIGNOFF.replace('-', '-?')}\\s+${PASS}\\b`, 'i'), what: `${SIGNOFF.toLowerCase()} ${PASS} label` },
  { re: new RegExp(`^\\s*Pass:\\s*(?:ATTACK|REFINE|PROVE|${SIGNOFF.replace('-', '-?')})`, 'im'), what: 'pipeline pass header' },
  // NO tool-attribution marker. One existed and was REMOVED after review: it fired on ordinary
  // product prose ("the next page token is generated by cursor position", "rows written by
  // cursor batches"), because `cursor` and `codex` are ordinary technical nouns; and worse, an
  // AI PRODUCT legitimately documents "captions are generated by Gemini" or "answers are
  // generated by Claude via the API" - which is the exact class of product this pipeline builds.
  // Paired with a remedy that reads "untrack this", that is the over-delete failure mode this
  // work stream exists to prevent, and the two false-positive controls in the selftest are what
  // hold the line. (An earlier version of this comment justified the removal by saying the gate
  // was "wired into six product pre-commit hooks". It is wired into NONE: audited 2026-07-26
  // across all 81 project dirs, this file exists only here, with zero hook references. It is a
  // SCAFFOLD - pipeline pass 1 copies scaffold-gates/ into a product repo, and no repo has run
  // that pass since the gate was written. The removal reasoning stands on the controls; the
  // deployment count was invented. Do not restore a marker on the strength of it.) Attribution
  // TRAILERS ("Generated with ...", "Co-Authored-By: ...") are already a strong deslop rule, and
  // deslop is the designated slop gate: one tool, one layer.
];

// WHERE CONTENT IS SCANNED.
//
// SOURCE is excluded on purpose: pass numbering is ordinary language in code and tests, and a
// gate whose remedy reads "untrack this" must not fire on real product code. The over-delete
// this work stream exists to stop began exactly that way.
//
// Everything else that is TEXT is included. An earlier revision narrowed this to markdown and
// JSON/YAML, which silently dropped html, log, csv, xml, toml and friends - a regression that
// mattered live, since one estate repo tracks 57 `.log` and 25 `.html` files. None of those is
// source, so the source rationale never applied to them.
// The tail group closes gaps that were arbitrary rather than reasoned, each measured with the
// identical marker text in a covered format as the control: `.jsonl` was unscanned while `.ndjson`
// was, `.jsonc` while `.json` was, and `.svg` while `.xml` was, though each pair is one format.
// `.har` and `.trace` are the sharper miss: the directory rule counts them as UNAMBIGUOUS pipeline
// output, yet their contents were never read, so one sitting outside a pass directory was invisible
// to both rules. They can exceed MAX_BYTES and turn a run UNKNOWN, which is the designed answer
// here: refusing to report clean on a file it could not inspect is the whole point of that path.
const CONTENT_EXT_RE = /\.(md|markdown|mdx|txt|rst|adoc|org|tex|json|ndjson|sarif|ya?ml|toml|ini|cfg|conf|html?|xml|csv|tsv|log|diff|patch|jsonl|jsonc|svg|har|trace|lock)$/i;
// Extensionless tracked files (LICENSE, Procfile, CODEOWNERS) AND hidden extensionless ones
// (`.notes`, `docs/.handover`), which an earlier `[^./]+$` skipped while its comment claimed
// extensionless coverage. The basename must contain no dot AFTER an optional leading one, so
// `src/v1.2/README` (dot in a DIRECTORY) is still covered and `render.ts` is still excluded.
const NO_EXT_RE = /(^|\/)\.?[^./]+$/;
const MAX_BYTES = 4 * 1024 * 1024;

function repoRoot(cwd) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', windowsHide: true,
  }).trim();
}

function scan(cwd) {
  // Resolve the repo ROOT first and run every git call and every read from there. Without it a
  // run from a subdirectory (a monorepo whose package.json lives in web/, which is where
  // `npm run gate` executes) enumerated only that subtree and printed a confident "clean".
  let root;
  try {
    root = repoRoot(cwd);
  } catch (e) {
    return { unknown: true, reason: `not a git repository at ${cwd}: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }

  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch (e) {
    return { unknown: true, reason: `git ls-files failed: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }
  if (files.length === 0) {
    return { unknown: true, reason: 'git ls-files returned no tracked files (empty index)', findings: [] };
  }

  const findings = [];
  // Computed once, over the whole tracked set: the pass-directory rule is a per-DIRECTORY
  // judgement (does this directory contain source?) and cannot be decided from a single path.
  const passFiles = passDirectoryFiles(files);
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    // Case-INSENSITIVE: bina-yomit tracks `.Codex/reviews/...` with a capital C, which an exact
    // match let through. Windows and macOS are case-insensitive filesystems.
    const lower = norm.toLowerCase();
    for (const p of FORBIDDEN_PATHS) {
      const pl = p.toLowerCase();
      if (pl.endsWith('/') ? lower.startsWith(pl) : lower === pl) {
        findings.push({ file: norm, why: `forbidden path (${p})` });
      }
    }
    const passHit = passFiles.get(norm);
    if (passHit) {
      findings.push({
        file: norm,
        why: passHit.confident
          ? 'pass-numbered directory (pipeline output)'
          : 'pass-numbered directory (ADVISORY: unrecognised files present, confirm before untracking)',
      });
    }
  }

  // Read failures are NOT skipped silently. A tracked file missing from the working tree
  // (sparse checkout, partial clone, unstaged delete) previously hit `catch { continue; }` while
  // still being counted as scanned, so the run printed "clean (N scanned)" with the leak intact.
  // Real submodule entries, identified by git's own mode (160000), NOT by guessing from an
  // errno. The previous code skipped anything that raised EISDIR/ELOOP, so a tracked file
  // REPLACED BY A DIRECTORY was silently passed over and the run still printed "clean".
  const gitlinks = new Set();
  try {
    for (const line of execFileSync('git', ['ls-files', '-s', '-z'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).split('\0')) {
      if (line.startsWith('160000 ')) gitlinks.add(line.slice(line.indexOf('\t') + 1));
    }
  } catch { /* no gitlinks resolvable; every read failure then counts as unreadable */ }

  const unreadable = [];
  let read = 0;
  for (const f of files) {
    if (!CONTENT_EXT_RE.test(f) && !NO_EXT_RE.test(f)) continue;
    if (gitlinks.has(f)) continue; // a submodule has no content of its own here
    let buf;
    try {
      buf = readFileSync(join(root, f));
    } catch (e) {
      unreadable.push(`${f} (${(e && e.code) || 'read error'})`);
      continue;
    }
    // Truncating and scanning the head is a SILENT FALSE CLEAN: a 4.6MB log with the report on
    // its last line came back clean, exit 0, with the file never mentioned. If we cannot inspect
    // all of it, we have not inspected it.
    //
    // MEASURE THE FILE, THEN DECODE. Two earlier versions both measured the decoded string.
    // `body.length` counts UTF-16 code units, so the threshold moved with the alphabet (a 9.44MB
    // CJK log scanned whole, an 8.39MB emoji log refused as "4MB"). Switching to
    // Buffer.byteLength(body) fixed the alphabet skew but still measures the DECODE, not the
    // file: every byte that is not valid UTF-8 decodes to U+FFFD, which is 3 bytes, so review
    // measured a 2,097,152-byte latin-1 file reporting exactly 6,291,456. Extensionless binaries
    // and CP1252 logs above ~1.33MB were refused as oversized, turning the whole run UNKNOWN.
    // buf.length is the byte count on disk, with no encoding in the path at all.
    if (buf.length > MAX_BYTES) {
      unreadable.push(`${f} (too large to scan fully: ${(buf.length / 1048576).toFixed(1)}MB)`);
      continue;
    }
    const body = buf.toString('utf8');
    read++;
    for (const m of CONTENT_MARKERS) {
      if (m.re.test(body)) { findings.push({ file: f.replace(/\\/g, '/'), why: `content: ${m.what}` }); break; }
    }
  }
  if (unreadable.length) {
    return {
      unknown: true,
      reason: `could not read ${unreadable.length} tracked file(s): ${unreadable.slice(0, 5).join(', ')}`,
      findings,
    };
  }

  const seen = new Set();
  const unique = findings.filter(x => {
    const k = x.file + '|' + x.why;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { unknown: false, ok: unique.length === 0, findings: unique, scanned: files.length, read, root };
}

function report(res) {
  if (res.unknown) {
    console.error(`[ship-artifacts] UNKNOWN: ${res.reason}`);
    console.error('[ship-artifacts] Refusing to report clean on a scan that did not run.');
    // Anything already found is still real and still worth acting on. These used to be
    // collected and then dropped on this path, so an UNKNOWN run hid confirmed artifacts.
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return 2;
  }
  if (res.ok) {
    console.log(`[ship-artifacts] clean (${res.scanned} tracked, ${res.read} read)`);
    return 0;
  }
  console.error(`[ship-artifacts] ${res.findings.length} AI-process artifact(s) TRACKED in git:`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  // EACH REMEDY PRINTS ONLY WHEN ITS OWN FINDING TYPE IS PRESENT. The untrack instruction used to
  // print unconditionally, so a run whose only findings were pass-numbered directories opened with
  // "untrack them" and reached the caveat five lines later, if at all.
  if (res.findings.some((f) => /^forbidden path/.test(f.why))) {
    console.error('');
    console.error('PATH hits are artifacts: untrack them (they stay on disk):');
    console.error('  git rm -r --cached <path>   then add to .gitignore');
  }
  if (res.findings.some((f) => /pass-numbered directory/.test(f.why))) {
    // BOTH GRADES ARE A REPORT, NOT AN INSTRUCTION, and this is the correction that matters most.
    //
    // `pipeline output` was documented as the grade "you can untrack". It cannot be. The grade says
    // every file here is a format this gate RECOGNISES, which is not the same as every file being
    // something a pipeline EMITTED, and no content test can tell those apart: measured on this
    // version, `public/images/hero-pass-1/` holding four product .jpg files and
    // `internal/gfx/testdata/blur-pass-2/` holding three Go golden .png files both score confident,
    // because a product image and a screenshot are the same bytes. `packages/icons-pass-1/` went
    // further and named package.json and README.md under an untrack heading.
    //
    // A false positive here is an instruction to delete product code, which is how the six previous
    // versions of this rule went wrong. So the gate stops claiming a certainty it cannot have: it
    // reports what it measured, a pass-shaped directory holding at least three unambiguous
    // artifacts, and the operator looks. The grades still say how much was unrecognised; they no
    // longer license a deletion.
    console.error('');
    console.error('PASS-NUMBERED DIRECTORIES ARE A REPORT, NOT AN INSTRUCTION - both grades.');
    console.error('"pipeline output" means every file is a format this gate recognises, NOT that a');
    console.error('pipeline produced them: product images and screenshots are the same bytes to any');
    console.error('content test. "ADVISORY" means the directory also holds something unrecognised.');
    console.error('CONFIRM BEFORE UNTRACKING: open the directory, satisfy yourself it is pipeline');
    console.error('output rather than product files, and only then untrack it. Never on this alone.');
  }
  if (res.findings.some((f) => /^content:/.test(f.why))) {
    console.error('');
    console.error('CONTENT hits need a JUDGEMENT, not a reflex. If the file is a genuine product');
    console.error('document whose wording merely leaks pipeline vocabulary (a README, an ADR),');
    console.error('edit the wording - untracking it hides the leak rather than removing it. If it');
    console.error('is a pipeline REPORT that no path rule happened to name, untrack it like any');
    console.error('other artifact. Open the file and decide which it is.');
  }
  return 1;
}

// --- selftest -------------------------------------------------------------
// EVERY RULE GETS ITS OWN ISOLATED CONTROL. The first version used one fixture that tripped
// three markers at once, so disabling any single marker left the selftest green: four of five
// single-rule mutations escaped. A control that cannot fail alone proves nothing about the rule
// it is named after.
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-'));
  git(['init'], root);
  git(['config', 'user.email', 'selftest@example.invalid'], root);
  git(['config', 'user.name', 'selftest'], root);
  const noHooks = join(root, '.no-hooks');
  mkdirSync(noHooks);
  git(['config', 'core.hooksPath', noHooks], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // THE AMBIENT GLOBAL GITIGNORE REACHES INTO EVERY FIXTURE, and it VOIDS controls silently rather
  // than failing them. `node_modules/` is in most developers' global excludes, and `git add -A`
  // skips ignored paths without a word, so the `node_modules/thing/artifacts/verify-pass-6` case
  // below stages only the two README files: it then passes whether or not the source-root rule it
  // is named after does anything at all.
  //
  // MEASURED, stated at the third attempt. The first version claimed the deleted-rule run stayed
  // green, which is not what the run showed; the second stated the right numbers but not the
  // CONFIGURATION they came from, and review found they only reproduce against a build that also
  // has the staged-count assertion below removed.
  //
  // So, precisely: the three cells describe THE GATE AS IT WAS BEFORE THIS FIX - both the three
  // lines below AND the staged-count assertion after the commit removed. Global excludesfile holds
  // just `node_modules/` unless stated. Verdict from the exit code.
  //   rule intact                    exit 0, 0 failed controls   suite green, control proved nothing
  //   rule DELETED                   exit 1, 1 failed control    only the vendor/ sibling fired
  //   rule DELETED, empty excludes   exit 1, 2 failed controls   both source-root controls fired
  // So the mutation never escaped: the vendor/ sibling kept it in contact. What died in silence was
  // one of two redundant controls, and only on machines that ignore node_modules.
  //
  // Against the SHIPPED file those inputs behave differently, which is the fix working rather than
  // a contradiction: the middle cell becomes 2 failed controls, and removing only these three lines
  // while keeping the assertion stops the suite at `fixture staged 2 of 5` instead.
  // Every other ambient influence is already cut off above; this one was not. It travels, because
  // scaffold-gates/ is copied verbatim into product repos on other people's machines.
  // The file lives under .git/ so it can never be staged by the `git add -A` below.
  const noExcludes = join(root, '.git', 'empty-excludes');
  writeFileSync(noExcludes, '');
  git(['config', 'core.excludesFile', noExcludes.replace(/\\/g, '/')], root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(['add', '-A'], root);
  git(['commit', '-m', 'fixture'], root);
  // A FIXTURE THAT DID NOT STAGE WHAT IT WROTE IS A FALSE CLEAN, not a passing case. The
  // excludesFile above is one way that happens; a name the platform refuses is another. Both leave
  // a case asserting nothing while the suite prints green, which is the same defect this whole
  // file exists to hunt - just one level up, in the harness rather than the rule. So compare what
  // landed in the index against what was written and fail loudly on any gap.
  // Proven to fire: with the excludesFile line above removed and a global ignore of `node_modules/`
  // this throws `staged 2 of 5`; with it in place it stays silent.
  const staged = git(['ls-files'], root).split('\n').filter(Boolean);
  const wanted = Object.keys(files).length;
  if (staged.length !== wanted) {
    throw new Error(`fixture staged ${staged.length} of ${wanted} file(s) - this case would ` +
      `assert nothing. Staged: ${staged.join(', ') || '(none)'}`);
  }
  return root;
}

function selftest() {
  const cases = [];
  const clean = { 'README.md': '# Thing\n\nInstall and run.\n', 'PRODUCT.md': '# Product\n\nWho it is for.\n' };

  // NEGATIVE control: legitimate product docs must pass.
  cases.push({ name: 'clean product docs accepted', files: { ...clean, 'docs/VERIFICATION.md': '# Verification\n\nHow to check the build.\n' }, expect: 'clean' });

  // FALSE-POSITIVE control. Pass numbering is ordinary language in source and tests, and the
  // gate tells you to untrack what it finds - firing here would push an operator to delete real
  // product code. This asserts the source-file exclusion actually holds.
  cases.push({
    name: 'source and tests are NOT content-scanned (no false positive)',
    files: {
      ...clean,
      'src/render.ts': `// render ${PASS} 2 of 3 completes the frame\nexport const x = 1;\n`,
      'src/render.test.ts': `it('handles ${PASS} 2 of 3 correctly', () => {});\n`,
    },
    expect: 'clean',
  });

  // One POSITIVE control per rule, each tripping ONLY that rule.
  cases.push({ name: 'path rule: root VERIFICATION.md', files: { ...clean, 'VERIFICATION.md': 'output\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: case-variant .Codex/', files: { ...clean, '.Codex/reviews/n.json': '{"a":1}\n' }, expect: 'fail' });
  {
    // Three real artifacts, not one `.txt`: `.txt` is FURNITURE now and abstains, so a fixture
    // built from it would assert the rule fires on a file that no longer votes at all.
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`artifacts/refine-pass-4/shot${i}.png`] = 'p\n';
    cases.push({ name: 'dir rule: pass-numbered directory', files, expect: 'fail' });
  }
  // Content rules live in paths NO path rule covers, so only the named marker can catch them.
  cases.push({ name: `content rule: ${PASS} numbering, parenthesised`, files: { ...clean, 'docs/notes/a.md': `# Report\n\nPROVE ${PASS} (2 of 5) complete\n` }, expect: 'fail' });
  cases.push({ name: `content rule: ${PASS} numbering, slash form`, files: { ...clean, 'docs/notes/b.md': `# Report\n\nrefine ${PASS} 4/5 done\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: sign-off label', files: { ...clean, 'docs/notes/c.md': `# Handover\n\n${SIGNOFF} ${PASS} complete\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: pipeline header', files: { ...clean, 'docs/notes/d.md': `# X\n\nPass: ATTACK\n` }, expect: 'fail' });
  // FALSE-POSITIVE controls for the two rules review showed firing on real product content.
  cases.push({
    name: 'ordinary product prose is NOT flagged as tool attribution',
    files: {
      ...clean,
      'docs/api.md': '# API\n\nThe next page token is generated by cursor position, not by offset.\n',
      'docs/ai.md': '# AI\n\nImage captions are generated by Gemini, answers by Claude via the API.\n',
    },
    expect: 'clean',
  });
  cases.push({
    name: 'an ordinary directory containing "pass" is NOT a pass-numbered directory',
    files: { ...clean, 'src/multipass-3/shader.ts': 'export const x = 1;\n', 'src/bypass-2/i.ts': 'export const y = 2;\n' },
    expect: 'clean',
  });
  // ONE CONTROL PER FORMAT. A single `.log` fixture left 15 of 16 restored formats uncontrolled:
  // dropping `html?` alone made a tracked `docs/report.html` invisible with --selftest green,
  // and bina-yomit tracks 25 `.html`.
  // `json`, `ya?ml` and `markdown` were absent from this loop, so dropping any of them from
  // CONTENT_EXT_RE left the selftest green. json matters most: the only json fixture anywhere was
  // `.Codex/reviews/n.json`, which a PATH rule catches, so json CONTENT was wholly untested - and
  // json review dumps are exactly what the estate was leaking.
  for (const ext of ['log', 'html', 'htm', 'csv', 'tsv', 'xml', 'toml', 'ini', 'cfg', 'conf',
    'org', 'tex', 'ndjson', 'sarif', 'diff', 'patch', 'rst', 'adoc', 'mdx', 'txt',
    'json', 'yaml', 'yml', 'markdown',
    // The formats whose twins were already covered while they were not, plus the two the
    // directory rule calls pipeline output without ever reading them.
    'jsonl', 'jsonc', 'svg', 'har', 'trace', 'lock']) {
    cases.push({
      name: `content rule reaches .${ext}`,
      files: { ...clean, [`out/report.${ext}`]: `${SIGNOFF} ${PASS} complete\n` },
      expect: 'fail',
    });
  }
  cases.push({ name: 'content rule reaches hidden extensionless files', files: { ...clean, 'docs/.handover': `${SIGNOFF} ${PASS} complete\n` }, expect: 'fail' });
  cases.push({ name: 'content rule reaches plain extensionless files', files: { ...clean, 'docs/HANDOVER': `${SIGNOFF} ${PASS} complete\n` }, expect: 'fail' });

  // Directory-rule shape, both directions. The producers must be caught and ordinary source
  // directories must not - each was broken by a different earlier version of the pattern.
  // Includes an UPPERCASE variant: every other directory fixture is lowercase, so dropping the
  // /i flag went undetected by the whole suite. Windows and macOS are case-insensitive, so a
  // repo really can carry either spelling.
  // `design/...` leads this list because it is a MEASURED live leak, not a hypothetical: an
  // artifacts/-anchored version of this rule scored 0 against watt-to-fly's 125 tracked
  // refine/sign-off baseline PNGs. The verify/a11y/taste/design names are here because a
  // pass-NAME list silently stopped catching them. Any prefix is accepted, so a pass name
  // invented next month is covered without editing this rule.
  for (const dir of ['design/refine-pass-4', 'design/signoff-pass-5', 'design/refine-pass-4/baseline',
    'artifacts/refine-pass-4', 'artifacts/signoff-pass-5', 'artifacts/refine-final-pass-4',
    'artifacts/verify-pass-6', 'artifacts/a11y-pass-3', 'artifacts/taste-pass-5', 'artifacts/design-pass-2',
    'artifacts/pass-2', 'artifacts/nested/deep-pass-9', 'docs/pass-3', 'reports/attack-pass-2',
    'pass-3', 'artifacts/REFINE-PASS-4', 'artifacts/SignOff-Pass-5',
    // MONOREPO layouts. A version of this rule suppressed `apps/`, `packages/` and `examples/`
    // wholesale as "source roots", which missed the exact measured leak shape one level down --
    // and that is the DEFAULT Turborepo/Nx layout for the sites this pipeline builds.
    'apps/web/design/refine-pass-4', 'packages/site/design/signoff-pass-5',
    'apps/mobile/artifacts/verify-pass-6', 'examples/demo/artifacts/refine-pass-4']) {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`${dir}/shot${i}.png`] = 'p\n';
    cases.push({ name: `dir rule catches ${dir}/`, files, expect: 'fail' });
  }
  // CONTENT decides, so a pass-shaped directory holding SOURCE is code wherever it lives. These
  // are real framework layouts that a first-segment-only source-root check FLAGGED with a
  // "git rm -r --cached" remedy: measured 5 of 6 before content became the primary signal.
  for (const [dir, file] of [
    ['web/src/render-pass-1', 'x.ts'],
    ['app/src/main/java/com/x/render-pass-1', 'A.java'],
    ['crates/core/src/render-pass-1', 'm.rs'],
    ['internal/gfx/blur-pass-2', 'b.go'],
    ['server/src/final-pass-2', 'y.ts'],
    ['components/blur-pass-2', 'index.tsx'],
    // NOT `.ts`. This was `shaders/render-pass-1/frag.ts` - a shader directory holding the one
    // extension a shader directory would never hold - which is exactly why the extension gap
    // below stayed invisible.
    ['shaders/render-pass-1', 'frag.glsl'],
  ]) {
    cases.push({ name: `dir rule leaves ${dir}/ alone (not pipeline output)`, files: { ...clean, [`${dir}/${file}`]: 'x\n' }, expect: 'clean' });
  }
  // EXTENSIONS THE OLD SOURCE LIST DID NOT KNOW. Every one of these was measured FLAGGED with a
  // "git rm -r --cached" remedy, on a rule whose stated purpose is to avoid exactly that. They
  // are here because enumerating source extensions can never be finished; enumerating the
  // pipeline's own OUTPUT types can.
  for (const [dir, names] of [
    ['gfx/render-pass-1', ['a.hlsl', 'b.metal']],
    ['render/blur-pass-2', ['blur.wgsl']],
    ['proto/schema-pass-2', ['user.proto']],
    ['infra/deploy-pass-1', ['main.tf']],
    ['esm/build-pass-3', ['index.mts']],
    ['ui/blur-pass-2', ['styles.module.css']],
    ['hw/sim-pass-2', ['top.sv']],
  ]) {
    const files = { ...clean };
    for (const n of names) files[`${dir}/${n}`] = 'x\n';
    cases.push({ name: `dir rule leaves ${dir}/ alone (unlisted code extension)`, files, expect: 'clean' });
  }
  // ONE STRAY FILE MUST NOT SILENCE A LEAK. Measured: 120 leaking PNGs plus one viewer.js
  // reported CLEAN, because the old rule silenced a directory if ANY file looked like source.
  {
    const files = { ...clean, 'design/refine-pass-4/viewer.js': 'render();\n' };
    for (let i = 0; i < 12; i++) files[`design/refine-pass-4/baseline/shot${i}.png`] = 'p\n';
    cases.push({ name: 'a lone script does NOT silence a directory of screenshots', files, expect: 'fail' });
  }
  // A source-root NAME below the pass directory must not exonerate it either.
  cases.push({
    name: 'a spec/ folder INSIDE a pass directory does not exonerate it',
    files: { ...clean, 'design/refine-pass-4/spec/a.png': 'p\n', 'design/refine-pass-4/spec/b.png': 'p\n', 'design/refine-pass-4/spec/c.png': 'p\n' },
    expect: 'fail',
  });
  // NESTED pass directories must be judged SEPARATELY. Keying on the outermost segment merges
  // them into one bucket where they exonerate each other: an inner directory full of source made
  // the outer directory's screenshots disappear. Without this control that keying is unproven -
  // the mutation swapping the innermost key for the outermost ESCAPED.
  {
    // THE COUNTS ARE LOAD-BEARING, so do not "tidy" them. The verdict no longer depends on a
    // ratio, so the old 6-and-8 fixture would be VACUOUS here: 6 screenshots clear the floor and
    // the directory is flagged under either keying. What separates the two keyings now is the
    // FLOOR. Two artifacts in the outer directory and two in the inner is below it twice over, so
    // correct keying reports nothing; merging them makes four and flags. Wrong keying therefore
    // turns this control RED, which is the only thing that makes it a control.
    //
    // KNOWN MISS, and this control is what pins it, so read it before "fixing" either. Because the
    // floor is applied per innermost directory, artifacts SPREAD across nested pass directories
    // never reach it: measured 2026-07-27, six screenshots at two per level across three nested
    // pass directories report CLEAN, while the same six in ONE directory are caught. Summing up
    // the tree would close that, but it WIDENS detection, and widening is the direction that
    // deletes product files. It is left open deliberately while the confidence grade cannot
    // distinguish product images from screenshots; closing both at once is the redesign, not a
    // patch. A miss here costs an unnoticed leak; the other direction costs somebody's code.
    const files = { ...clean };
    for (let i = 0; i < 2; i++) files[`design/refine-pass-4/shot${i}.png`] = 'p\n';
    for (let i = 0; i < 2; i++) files[`design/refine-pass-4/tools-pass-2/shot${i}.png`] = 'p\n';
    cases.push({ name: 'nested pass dirs are judged separately, not merged over the floor', files, expect: 'clean' });
  }
  {
    // The other direction, kept from the version this replaces: source in an INNER pass directory
    // must not make the outer directory's screenshots disappear. Nothing suppresses a finding any
    // more, so this now holds structurally rather than by arithmetic, and the control pins it.
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`design/refine-pass-4/shot${i}.png`] = 'p\n';
    files['design/refine-pass-4/tools-pass-2/gen.ts'] = 'export const x = 1;\n';
    cases.push({ name: 'a nested source pass dir does not exonerate the outer screenshots', files, expect: 'fail' });
  }
  // THE REGRESSION SET FROM THE v6 REVIEW (2026-07-27). Every one of these was MEASURED FLAGGED on
  // the previous version, each with a `git rm -r --cached` remedy attached, because the furniture
  // counted as pipeline output and an exact tie flagged. 9 of the 10 leave-alone fixtures above
  // flipped the moment one ordinary README was added, so the README is the fixture here.
  for (const [label, extra] of [
    ['one README does not turn a shader directory into a delete instruction',
      { 'shaders/render-pass-1/frag.glsl': 'x\n', 'shaders/render-pass-1/README.md': '# shaders\n' }],
    ['one README does not turn a wgsl directory into a delete instruction',
      { 'render/blur-pass-2/blur.wgsl': 'x\n', 'render/blur-pass-2/README.md': '# blur\n' }],
    ['a package directory is not pipeline output',
      { 'packages/render-pass-1/package.json': '{}\n', 'packages/render-pass-1/tsconfig.json': '{}\n',
        'packages/render-pass-1/README.md': '# x\n', 'packages/render-pass-1/src/index.ts': 'export const x=1;\n' }],
    ['config furniture alone is not pipeline output',
      { 'infra/deploy-pass-1/main.tf': 'x\n', 'infra/deploy-pass-1/policy.json': '{}\n',
        'infra/deploy-pass-1/compose.yml': 'x\n', 'infra/deploy-pass-1/README.md': '# x\n' }],
    ['an svg icon beside a component is not pipeline output',
      { 'components/blur-pass-2/index.tsx': 'x\n', 'components/blur-pass-2/icon.svg': '<svg/>\n' }],
  ]) {
    cases.push({ name: `leave alone: ${label}`, files: { ...clean, ...extra }, expect: 'clean' });
  }
  // THE MISSES FROM THE SAME REVIEW, which matter just as much: an UNRECOGNISED extension used to
  // vote AGAINST a finding, so a directory of real pipeline output reported CLEAN.
  for (const [label, names] of [
    ['jsonl traces', ['t1.jsonl', 't2.jsonl', 't3.jsonl']],
    ['sarif reports', ['semgrep.sarif', 'trivy.sarif', 'zap.sarif']],
    ['screenshots outnumbered by traces', ['a.png', 'b.png', 'c.png', 't1.jsonl', 't2.jsonl', 't3.jsonl', 't4.jsonl']],
    ['a har capture set', ['one.har', 'two.har', 'three.har']],
  ]) {
    const files = { ...clean };
    for (const n of names) files[`artifacts/refine-pass-4/${n}`] = 'x\n';
    cases.push({ name: `dir rule catches ${label}`, files, expect: 'fail' });
  }
  // THE FLOOR, STRADDLED. Review found the threshold had no control on either side, and that both
  // the comparison and the format list could be mutated away without turning this suite red.
  {
    const two = { ...clean };
    for (let i = 0; i < 2; i++) two[`assets/icon-pass-1/img${i}.png`] = 'p\n';
    cases.push({ name: 'two artifacts are below the floor and left alone', files: two, expect: 'clean' });
    const three = { ...clean };
    for (let i = 0; i < 3; i++) three[`assets/icon-pass-1/img${i}.png`] = 'p\n';
    cases.push({ name: 'three artifacts reach the floor and are caught', files: three, expect: 'fail' });
  }
  // CONFIDENCE IS THE REMEDY, so it is controlled in BOTH directions. A branch that decides
  // whether the operator is told to delete something, and that no control can observe, is worse
  // than no branch at all.
  {
    const confident = { ...clean, 'design/refine-pass-4/manifest.json': '{}\n' };
    for (let i = 0; i < 3; i++) confident[`design/refine-pass-4/shot${i}.png`] = 'p\n';
    cases.push({
      name: 'a directory of pure output is named as output, not merely advised',
      files: confident, expect: 'fail', expectWhy: /pipeline output/, forbidWhy: /ADVISORY/,
      // The manifest ABSTAINED from the decision, so it must not appear in the finding list. A
      // confident directory used to be named as a unit, which put package.json and README.md into
      // a report whose remedy was "untrack" for any product directory matching the name shape.
      // Without this, the confident grade's file scope has no control at all.
      forbidFile: /manifest\.json$/,
    });
    // A Go golden-file directory reaches the floor on its testdata. It IS reported, because the
    // gate cannot read `.go` and must not pretend the directory is clean; but it must never be
    // reported as a confident untrack instruction, and the `.go` file itself must not be listed.
    const advisory = { ...clean, 'internal/gfx/blur-pass-2/blur.go': 'package gfx\n' };
    for (let i = 0; i < 3; i++) advisory[`internal/gfx/blur-pass-2/testdata/golden${i}.png`] = 'p\n';
    cases.push({
      name: 'a source directory holding golden images is ADVISORY, never a delete instruction',
      files: advisory, expect: 'fail', expectWhy: /ADVISORY/, forbidFile: /\.go$/,
    });
    // THE SHAPE THAT MADE THIS A CRITICAL, pinned as its own control. A published package whose
    // name matches the pass shape reaches the floor on three icons, and every other file in it is
    // furniture, so it scored CONFIDENT and its package.json and README.md were listed under a
    // remedy reading "untrack". The directory is still REPORTED - the gate genuinely cannot tell
    // it from a screenshot dump, and pretending otherwise is the miss - but the manifest and the
    // readme must never appear in the list, and the remedy must ask for confirmation.
    const pkg = { ...clean, 'packages/icons-pass-1/package.json': '{}\n', 'packages/icons-pass-1/README.md': '# icons\n' };
    for (let i = 0; i < 3; i++) pkg[`packages/icons-pass-1/icon${i}.png`] = 'p\n';
    cases.push({
      name: 'a package directory is reported without naming its package.json or README',
      files: pkg, expect: 'fail', forbidFile: /package\.json$|packages\/icons-pass-1\/README\.md$/,
    });
  }
  // A PATH hit tells the operator to untrack, so every one of these was, at some version of this
  // rule, an instruction to delete real product code. The `*/artifacts/*` three were flagged by
  // the artifacts-anchored version, and they are the reason the exclusion is by SOURCE ROOT: the
  // dedicated bypass-2 / multipass-3 controls stopped holding the moment those directories sat
  // under anything named artifacts.
  for (const dir of ['src/render-pass-1', 'src/passes/blur-pass-2', 'src/multipass-3', 'src/bypass-2',
    'src/final-pass-2', 'src/build-pass-1', 'src/improve-pass-1', 'src/shipping-pass-1',
    'src/artifacts/render-pass-1', 'vendor/artifacts/x-pass-2', 'test/fixtures/artifacts/bypass-2',
    'packages/ui/src/render-pass-1', 'lib/compass-3']) {
    cases.push({ name: `dir rule leaves ${dir}/ alone`, files: { ...clean, [`${dir}/x.ts`]: 'export const x = 1;\n' }, expect: 'clean' });
  }

  // NAME-SHAPE CONTROLS, deliberately holding NO source file.
  //
  // Every leave-alone fixture above contains an `x.ts`, so the CONTENT signal alone keeps them
  // clean and MASKS every other rule. The mutation sweep proved that: removing the required
  // hyphen from the segment pattern, removing its end anchor, and removing the source-root name
  // signal ALL escaped, because no control depended on them. A fixture that trips several rules
  // at once proves nothing about any single one, so these carry a `.png` instead - only the
  // segment SHAPE can keep them clean.
  // THREE screenshots, not one, and that count is load-bearing for the same reason as the
  // source-root group below. With a single `.png` the directory sits UNDER the floor and is clean
  // whether or not the segment pattern matched it, so the separator and end-anchor mutations
  // would both escape: the control would be asserting nothing about the rule it is named after.
  for (const dir of ['design/compass-3', 'design/multipass-9', 'design/bypass-2',
    'design/pass-3-notes', 'design/refine-pass-4-draft']) {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`${dir}/shot${i}.png`] = 'binary-ish\n';
    cases.push({
      name: `dir rule leaves ${dir}/ alone on NAME SHAPE alone (no source present)`,
      files,
      expect: 'clean',
    });
  }
  // SOURCE-ROOT NAME control, also with no source file, so only that signal can keep it clean.
  // Without it the name list is dead weight, and a branch that can never fire is worse than none.
  // THE ARTIFACTS ARE LOAD-BEARING, so do not swap them back for a NOTES.md. That is what this
  // fixture used to hold, and once the furniture began ABSTAINING the directory was clean whether
  // the exemption ran or not: the sweep caught it as an ESCAPE on `source-root name signal`. Three
  // real screenshots put the directory OVER the floor, so only the source-root exemption can keep
  // it clean, and deleting that line now turns this control red.
  for (const dir of ['vendor/pkg/refine-pass-4', 'node_modules/thing/artifacts/verify-pass-6']) {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`${dir}/shot${i}.png`] = 'p\n';
    cases.push({
      name: `dir rule leaves ${dir}/ alone on the SOURCE-ROOT NAME alone`,
      files,
      expect: 'clean',
    });
  }

  let failures = 0;
  // A control that did not RUN is not a control that PASSED. Both skip paths below are legitimate
  // (a git that refuses local submodules, a harness not installed beside the gate), but counting
  // them as green let the summary claim "every rule fires alone" on a run where one did not fire.
  let skipped = 0;
  const roots = [];
  try {
    for (const c of cases) {
      const root = fixture(c.files);
      roots.push(root);
      const res = scan(root);
      const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
      const whys = (res.findings || []).map((f) => f.why);
      // A verdict-only assertion cannot see WHICH remedy the operator is handed, and the whole
      // point of this version is that "untrack this" and "confirm this yourself" are different
      // answers. expectWhy/forbidWhy give the confidence branch a control; without one it would
      // be a branch nothing can observe, which is worse than no branch at all.
      let problem = null;
      if (got !== c.expect) {
        problem = `expected ${c.expect}, got ${got}` + (whys.length ? ` (${whys.join('; ')})` : '');
      } else if (c.expectWhy && !whys.some((w) => c.expectWhy.test(w))) {
        problem = `no finding matched ${c.expectWhy} (${whys.join('; ') || 'no findings at all'})`;
      } else if (c.forbidWhy && whys.some((w) => c.forbidWhy.test(w))) {
        problem = `a finding matched ${c.forbidWhy}, which this case forbids (${whys.join('; ')})`;
      } else if (c.forbidFile && (res.findings || []).some((f) => c.forbidFile.test(f.file))) {
        problem = `a finding named a file matching ${c.forbidFile}, which this case forbids`;
      }
      if (problem) {
        failures++;
        console.error(`SELFTEST FAIL: ${c.name} -> ${problem}`);
      } else {
        console.log(`selftest ok: ${c.name}`);
      }
    }

    // UNKNOWN controls, one per way the scan can fail to run.
    const notRepo = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-norepo-'));
    roots.push(notRepo);
    if (!scan(notRepo).unknown) { failures++; console.error('SELFTEST FAIL: a non-repo must report UNKNOWN'); }
    else console.log('selftest ok: non-repo reports UNKNOWN, not clean');

    const emptyRepo = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-empty-'));
    roots.push(emptyRepo);
    git(['init'], emptyRepo);
    if (!scan(emptyRepo).unknown) { failures++; console.error('SELFTEST FAIL: an empty index must report UNKNOWN'); }
    else console.log('selftest ok: empty index reports UNKNOWN, not clean');

    // Subdirectory control: the scan must reach the repo ROOT from anywhere.
    const sub = fixture({ ...clean, 'VERIFICATION.md': 'x\n', 'web/package.json': '{"name":"w"}\n' });
    roots.push(sub);
    const fromSub = scan(join(sub, 'web'));
    if (fromSub.unknown || fromSub.ok) {
      failures++;
      console.error('SELFTEST FAIL: a run from a subdirectory missed a root artifact (false clean)');
    } else console.log('selftest ok: a subdirectory run still scans the whole repo');

    // Oversized-file control: truncating and scanning the head reads as clean while the tail was
    // never inspected. Must report UNKNOWN instead.
    const bigDir = fixture({ ...clean, 'docs/small.md': 'ok\n' });
    roots.push(bigDir);
    writeFileSync(join(bigDir, 'docs/big.md'), 'x'.repeat(MAX_BYTES + 1024) + `\n${SIGNOFF} ${PASS} complete\n`);
    git(['add', '-A'], bigDir); git(['commit', '-m', 'big'], bigDir);
    const bigRes = scan(bigDir);
    if (!bigRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: an oversized tracked file did not report UNKNOWN (silent partial scan)');
    } else console.log('selftest ok: an oversized file reports UNKNOWN rather than a partial clean');

    // SIZE-MEASUREMENT CONTROLS, one from each side. The fixture above is pure ASCII, where
    // buf.length, body.length and Buffer.byteLength(body) are all equal - so it pins nothing, and
    // reverting the byte accounting left the selftest green.
    //
    // A. UNDER the limit on disk, OVER it once decoded. Every invalid byte becomes U+FFFD, which
    // is 3 UTF-8 bytes, so measuring the DECODE inflates a 2MB file to 6MB and turns the whole
    // run UNKNOWN. Binaries and CP1252 logs above ~1.33MB hit this. Must be scanned, not UNKNOWN.
    const wideBytes = fixture({ ...clean, 'docs/keep.md': 'ok\n' });
    roots.push(wideBytes);
    writeFileSync(join(wideBytes, 'notes.log'), Buffer.alloc(2 * 1024 * 1024, 0xff));
    git(['add', '-A'], wideBytes); git(['commit', '-m', 'wide'], wideBytes);
    const wideRes = scan(wideBytes);
    if (wideRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a 2MB non-UTF-8 file reported UNKNOWN -> the size check is ' +
        'measuring the decoded string, not the file (' + wideRes.reason + ')');
    } else console.log('selftest ok: a non-UTF-8 file is measured by its real size, not its decode');

    // B. OVER the limit in bytes, UNDER it in UTF-16 code units. 1.5M CJK characters are 4.5MB on
    // disk but only 1.5M units, so a length-based check scans a file it cannot fully inspect.
    const cjk = fixture({ ...clean, 'docs/keep2.md': 'ok\n' });
    roots.push(cjk);
    writeFileSync(join(cjk, 'big-cjk.log'), '漢'.repeat(1500000));
    git(['add', '-A'], cjk); git(['commit', '-m', 'cjk'], cjk);
    const cjkRes = scan(cjk);
    if (!cjkRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a 4.5MB CJK file was scanned as if under the limit -> the ' +
        'size check is counting UTF-16 code units, not bytes');
    } else console.log('selftest ok: a multi-byte file is measured in bytes, not UTF-16 units');

    // Directory-shaped tracked path: previously skipped on errno and reported clean.
    const dirPath = fixture({ ...clean, 'docs/notes.md': 'ok\n' });
    roots.push(dirPath);
    unlinkSync(join(dirPath, 'docs/notes.md'));
    mkdirSync(join(dirPath, 'docs/notes.md'));
    const dirRes = scan(dirPath);
    if (!dirRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a tracked path replaced by a directory did not report UNKNOWN');
    } else console.log('selftest ok: a directory-shaped tracked path reports UNKNOWN');

    // Findings-under-UNKNOWN control: an artifact already confirmed by a PATH rule must still be
    // NAMED when the run ends UNKNOWN. Those were collected and then dropped, so an UNKNOWN run
    // hid confirmed leaks; the fix had no control until now.
    const mixed = fixture({ ...clean, 'VERIFICATION.md': 'x\n', 'docs/gone.md': 'ok\n' });
    roots.push(mixed);
    unlinkSync(join(mixed, 'docs/gone.md'));
    let mixedOut = '';
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: mixed, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    } catch (e) { mixedOut = (e.stdout || '') + (e.stderr || ''); }
    if (!/VERIFICATION\.md/.test(mixedOut) || !/UNKNOWN/.test(mixedOut)) {
      failures++;
      console.error('SELFTEST FAIL: an UNKNOWN run did not name the artifact it had already found');
    } else console.log('selftest ok: findings are still named when the run ends UNKNOWN');

    // Unreadable-file control: a file that is TRACKED but absent from the working tree (sparse
    // checkout, partial clone, an unstaged delete) must report UNKNOWN. Without this control a
    // mutation that silently skipped unreadable files escaped the whole selftest, and the run
    // printed a confident "clean" while the leak sat in the index unread.
    const missing = fixture({ ...clean, 'docs/notes/z.md': 'nothing notable\n' });
    roots.push(missing);
    unlinkSync(join(missing, 'docs/notes/z.md'));
    const missingRes = scan(missing);
    if (!missingRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a tracked-but-unreadable file did not report UNKNOWN');
    } else console.log('selftest ok: an unreadable tracked file reports UNKNOWN, not clean');

    // EXIT-CODE CONTROLS. Everything above calls scan() directly and never report(), so the only
    // layer a hook or a CI step ever reads had NO control at all:
    // changing `return 1` to `return 0` produced a gate that printed "2 artifacts TRACKED" and
    // exited 0, with --selftest green and the mutation harness still at 14/14. A gate is its
    // exit code. These run the real CLI as a subprocess, which is how a hook invokes it.
    const self = fileURLToPath(import.meta.url);
    const runCli = (cwd) => {
      try {
        execFileSync(process.execPath, [self], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
        return 0;
      } catch (e) { return e.status == null ? -1 : e.status; }
    };
    const exitCases = [
      ['clean repo exits 0', fixture({ ...clean }), 0],
      ['a tracked artifact exits 1', fixture({ ...clean, 'VERIFICATION.md': 'x\n' }), 1],
      ['a scan that could not run exits 2', mkdtempSync(join(tmpdir(), 'ship-artifacts-st-nr-')), 2],
    ];
    for (const [name, repo, want] of exitCases) {
      roots.push(repo);
      const got = runCli(repo);
      if (got !== want) { failures++; console.error(`SELFTEST FAIL: ${name} -> got exit ${got}`); }
      else console.log(`selftest ok: ${name}`);
    }

    // REMEDY CONTROLS. What the operator is TOLD TO DO had no control at all, which is how the
    // pass-directory remedy came to say "you can untrack it" about a directory this gate cannot
    // actually classify. The verdict and the exit code were both correct while the instruction
    // attached to them was dangerous, so nothing observed it.
    //
    // The remedy is printed by report(), on STDERR, so these read BOTH streams. A stdout-only
    // assertion here would pass on every input.
    const cliOut = (cwd) => {
      try {
        return execFileSync(process.execPath, [self], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
    };
    {
      // EACH RUN PRINTS EXACTLY ITS OWN REMEDY AND NO OTHER, asserted in BOTH directions for all
      // three blocks. Asserting only that the right paragraph is PRESENT pins the TEXT and leaves
      // the CONDITION unobservable, and the first version of these controls did exactly that for
      // the content block: measured, making the content condition unconditional left the suite at
      // 138 ok, 0 failures, exit 0, while the same edit on either sibling WAS caught - because the
      // sibling checks happened to assert absence and this one did not. Deletion was caught,
      // inversion was not, and two comments already claimed the branch was covered.
      //
      // A table beats three hand-written checks here precisely because the gap was an assertion
      // nobody noticed was missing: every remedy is now checked against every case by construction.
      const REMEDIES = {
        PATH: /PATH hits are artifacts/,
        'pass-directory': /CONFIRM BEFORE UNTRACKING/,
        CONTENT: /CONTENT hits need a JUDGEMENT/,
      };
      const expectExactly = (label, files, want) => {
        const repo = fixture(files);
        roots.push(repo);
        const out = cliOut(repo);
        const wrong = [];
        for (const [key, re] of Object.entries(REMEDIES)) {
          const printed = re.test(out);
          if (printed !== want.includes(key)) {
            wrong.push(printed ? `${key} printed but must not be` : `${key} missing`);
          }
        }
        if (wrong.length) {
          failures++;
          console.error(`SELFTEST FAIL: ${label} did not print exactly its own remedy (${wrong.join('; ')})`);
        } else console.log(`selftest ok: ${label} prints exactly its own remedy`);
      };

      // A directory of pure recognised output: the CONFIDENT grade. It must still demand a look,
      // and must not carry the untrack instruction that belongs to PATH hits.
      const confidentRepo = { ...clean };
      for (let i = 0; i < 3; i++) confidentRepo[`artifacts/refine-pass-4/shot${i}.png`] = 'p\n';
      expectExactly('a confident pass-directory-only run', confidentRepo, ['pass-directory']);
      // The same shape plus something unrecognised: the ADVISORY grade.
      const advisoryRepo = { ...clean, 'internal/gfx/blur-pass-2/blur.go': 'package gfx\n' };
      for (let i = 0; i < 3; i++) advisoryRepo[`internal/gfx/blur-pass-2/testdata/g${i}.png`] = 'p\n';
      expectExactly('an advisory pass-directory-only run', advisoryRepo, ['pass-directory']);
      // The other directions, so the assertions above cannot pass by printing everything.
      expectExactly('a PATH-only run', { ...clean, 'VERIFICATION.md': 'x\n' }, ['PATH']);
      expectExactly('a CONTENT-only run',
        { ...clean, 'docs/notes/report.md': `${SIGNOFF} ${PASS} complete\n` }, ['CONTENT']);
    }

    // Submodule control. The gitlink carve-out is keyed on git's 160000 mode; without a real
    // submodule fixture, breaking that lookup went undetected (every submodule repo would then
    // report UNKNOWN and every gate run would exit 2).
    const subRoot = fixture({ ...clean });
    roots.push(subRoot);
    const subDep = fixture({ 'lib.txt': 'dep\n' });
    roots.push(subDep);
    try {
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet',
        subDep.replace(/\\/g, '/'), 'vendor/dep'], { cwd: subRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'add submodule'], { cwd: subRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      const subRes = scan(subRoot);
      if (subRes.unknown || !subRes.ok) {
        failures++;
        console.error('SELFTEST FAIL: a real submodule made the scan report ' +
          (subRes.unknown ? 'UNKNOWN' : 'findings') + ' -> ' + (subRes.reason || ''));
      } else console.log('selftest ok: a real submodule is skipped without becoming UNKNOWN');
    } catch (e) {
      // A git that refuses local submodules is an environment limit, not a gate defect. Say so
      // rather than silently counting an unrun control as passed.
      skipped++;
      console.log('selftest SKIPPED: submodule control could not be built (' +
        String((e && e.message) || e).split('\n')[0] + ')');
    }

    // Self-reference, LAYER A: this very file, tracked, must not be flagged when installed.
    const selfSrc = readFileSync(new URL(import.meta.url), 'utf8');
    const selfRepo = fixture({ ...clean, 'scripts/check-ship-artifacts.mjs': selfSrc });
    roots.push(selfRepo);
    const selfRes = scan(selfRepo);
    if (selfRes.unknown || !selfRes.ok) {
      failures++;
      console.error('SELFTEST FAIL: the gate flags ITS OWN SOURCE once installed -> ' +
        (selfRes.findings || []).map(f => `${f.file} (${f.why})`).join(', '));
    } else console.log('selftest ok: the gate does not flag its own installed source');

    // Self-reference, LAYER B, tested INDEPENDENTLY of layer A.
    //
    // Layer A passes because a .mjs is never content-scanned, which means it passes whether or
    // not the source contains a literal marker example. That made the second layer - markers
    // assembled from fragments so no literal exists - unobservable, and review correctly called
    // the claim about it unverified. Applying the markers directly to the two shipped sources
    // is what makes it observable: if someone writes a literal example into a comment, this
    // fails even though the gate itself would still be clean.
    for (const [label, file] of [
      ['gate', new URL(import.meta.url)],
      ['mutants harness', new URL('./check-ship-artifacts.mutants.mjs', import.meta.url)],
    ]) {
      let body = null;
      try { body = readFileSync(file, 'utf8'); } catch { /* harness may not sit beside the gate */ }
      if (body === null) { skipped++; console.log(`selftest SKIPPED: ${label} source not readable beside the gate`); continue; }
      const selfHits = CONTENT_MARKERS.filter(m => m.re.test(body)).map(m => m.what);
      if (selfHits.length) {
        failures++;
        console.error(`SELFTEST FAIL: ${label} source contains a literal marker example (${selfHits.join(', ')}) - ` +
          'assemble it from fragments, or widening the extension allowlist would make this file its own violation');
      } else console.log(`selftest ok: ${label} source carries no literal marker example`);
    }
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }

  if (failures) {
    console.error(`\n[ship-artifacts] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  if (skipped) {
    console.log(`\n[ship-artifacts] selftest passed with ${skipped} control(s) SKIPPED. Every rule ` +
      'that RAN fires alone and clean docs stay clean, but the skipped control(s) proved nothing ' +
      'on this machine. Exit 0 because a skip is an environment limit, not a gate defect.');
    return 0;
  }
  console.log('\n[ship-artifacts] selftest passed: every rule fires alone, and clean docs stay clean.');
  return 0;
}

// Selftest only: strip the repo-pinning GIT_* variables a git hook exports to its children
// before any fixture work. From a LINKED WORKTREE that export is an absolute
// GIT_DIR=<host>/.git/worktrees/<name> (measured 2026-08-17; a plain-checkout hook exports no
// GIT_DIR at all), and with it set, every git call fixture() makes lands on the REAL repo
// regardless of cwd - the mechanism that made deslop-kit's e2e harness commit scratch state
// onto a live branch under a worktree pre-push. The MAIN scan path keeps the inherited
// environment on purpose: it queries the repo it was invoked in, which is exactly what a
// hook-exported pin describes.
if (process.argv.includes('--selftest')) {
  // The canary makes the strip OBSERVABLE (review 2026-08-17, both MEDIUMs): planted before the
  // strip, checked after, so deleting the strip loop alone turns every selftest run red instead
  // of silently re-opening the worktree-hook hole. Deleting plant, strip, and check together
  // still passes, like any guard removed whole; that residual is accepted and stated.
  // Case-INSENSITIVE on purpose (proven 2026-08-17): Windows environment lookups ignore case
  // while Object.keys reports the spelling as set, so `Git_Dir` survived a case-sensitive test
  // and was still honoured by child git. Measured on this very file with `Git_Dir` planted at a
  // canary repo: exit 1 and the canary's config rewritten.
  process.env.GIT_STRIP_CANARY = 'planted';
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  }
  if (process.env.GIT_STRIP_CANARY !== undefined) {
    console.error('[ship-artifacts] the GIT_* environment strip did not run: its planted canary '
      + 'survived. Refusing to build selftest fixtures with a possibly repo-pinned environment.');
    process.exit(2);
  }
  process.exit(selftest());
}
process.exit(report(scan(process.cwd())));
