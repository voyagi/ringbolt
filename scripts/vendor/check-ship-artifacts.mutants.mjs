#!/usr/bin/env node
// check-ship-artifacts.mutants.mjs - proves check-ship-artifacts.mjs --selftest can actually FAIL.
//
// WHY THIS SHIPS instead of being a claim in a commit message. The gate's first version carried
// "10 of 10 mutations caught" in its message with no harness in the tree, so the number was true
// that day and unverifiable afterwards. That is precisely how the version before it regressed:
// its selftest let four of five single-rule breaks through while looking green.
//
// Each mutant disables exactly ONE rule and asserts --selftest exits non-zero. Any ESCAPE means
// the control for that rule is vacuous: it passes whether or not the rule works.
//
// Usage: node scripts/check-ship-artifacts.mutants.mjs
// Exit codes: 0 all mutations caught, 1 at least one escaped.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), 'check-ship-artifacts.mjs');
const src = readFileSync(SRC, 'utf8');
// This harness's OWN source, copied beside every mutant so the gate's layer-B self-reference
// control can find it. See the writeFileSync below for why that is load-bearing.
const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');

const DEAD = '/$^/'; // a regex that can never match

// RE-RUNNING ONE MUTATION HAS TO BE CHEAP, or nobody does it. Fixing a control and then proving the
// fix is the whole loop this harness exists to serve, and a full sweep costs the better part of an
// hour - so the honest check kept being replaced by "the suite is still green", which is exactly
// the reasoning that lets a vacuous control survive. `--only <substring>` runs the matching
// mutations and nothing else.
//   node check-ship-artifacts.mutants.mjs --only "pass-dir output signal"
// The denominator below counts what was SELECTED, not MUTATIONS.length, so a filtered run reports
// "1/1 caught" rather than silently claiming the whole list it never attempted. (No count is
// written into these comments any more: every one of them went stale within a day of being typed.
// `MUTATIONS.length` is the number, and the summary line prints it.)
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i === -1) return null;
  const v = (process.argv[i + 1] || '').trim().toLowerCase();
  if (!v) { console.error('--only needs a substring of a mutation name'); process.exit(2); }
  return v;
})();

// WHAT THIS HARNESS STILL DOES NOT DO, measured 2026-08-09 rather than guessed, so the gap is a
// known quantity instead of an assumption. Its sibling check-client-secrets.mutants.mjs gained two
// checks this file lacks, and the port back was attempted and STOPPED at a prerequisite:
//
//   1. EXPECT BINDING. Each mutation there names the control it must turn red, and the run fails if
//      a DIFFERENT control fails instead. Without it, "some control went red" is the whole test, and
//      a rule whose own control was deleted still scores as caught off a neighbour's. That is not
//      theoretical: it was reproduced there by deleting a control outright and watching the harness
//      report full coverage.
//   2. REVERSE COVERAGE. It also asserts every control is reddened by at least one mutation, because
//      this style of harness only ever proves mutation -> control. A control that no mutation can
//      redden is never examined and can quietly stop asserting anything.
//
// THE PREREQUISITE, and why neither is here yet. Both key controls BY NAME, so a control must print
// the SAME name whether it passes or fails. The table-driven controls below already do:
// `SELFTEST FAIL: ${c.name} -> ${problem}` against `selftest ok: ${c.name}`, so stripping the reason
// recovers the identity. The HAND-WRITTEN controls do not. They print different prose per branch -
// "a non-repo must report UNKNOWN" when failing against "non-repo reports UNKNOWN, not clean" when
// passing - so nothing can tell those two lines describe one control.
//
// MEASURED over a full sweep (43 mutations, 136 controls, ~116 min): of the control names mutations
// reddened, 82 match a passing control and 21 MATCH NOTHING. So reverse coverage computes 82/136
// here, and that number is WRONG BY CONSTRUCTION, since up to 21 of the 54 apparently-unproven are
// proven under another name. Shipping it in that state would print a coverage claim this harness
// cannot support, which is the exact failure both of these checks exist to prevent.
//
// So the work, in order, for whoever picks this up: give every hand-written control ONE name used in
// both branches, THEN add `expect` per mutation, THEN turn on the reverse check. Doing the last two
// first produces a confident wrong number. Nothing above is a defect in the mutations below: the
// same sweep found all 43 parse, run, and redden at least one control.
const MUTATIONS = [
  ['pass-numbering marker', "what: 'pass numbering' }", `what: 'pass numbering', re: ${DEAD} }`],
  ['sign-off marker', '${PASS} label` }', '${PASS} label`, re: ' + DEAD + ' }'],
  ['pipeline-header marker', "what: 'pipeline pass header' }", `what: 'pipeline pass header', re: ${DEAD} }`],
  ['pass-numbered directory rule', 'const passHit = passFiles.get(norm);', 'const passHit = null;'],
  ['case-insensitive path matching', 'const lower = norm.toLowerCase();', 'const lower = norm;'],
  ['repo-root resolution', 'root = repoRoot(cwd);', 'root = cwd;'],
  ['unreadable-file reporting', "unreadable.push(`${f} (${(e && e.code) || 'read error'})`);", ''],
  ['oversized-file reporting', 'unreadable.push(`${f} (too large to scan fully', 'if (false) unreadable.push(`${f} (too large to scan fully'],
  // Mutate the LOOKUP, not the use. The previous mutation replaced the `gitlinks.has` branch
  // with an equivalent read-and-skip, so it did not disable gitlink discrimination at all and
  // was "caught" by two unrelated controls. Breaking the mode string is the real mutation, and
  // it escaped until a submodule fixture existed.
  ['gitlink mode lookup', "line.startsWith('160000 ')", "line.startsWith('999999 ')"],
  ['gitlink skip', 'if (gitlinks.has(f)) continue;', ''],
  // Must REMOVE formats, not add one. The first version of this mutation prepended an unused
  // extension, which changed nothing and therefore "escaped" - a mutation that does not mutate
  // proves nothing about the control, and reads as a coverage gap that is not there.
  ['non-source text coverage', 'json|ndjson|sarif|ya?ml|toml|ini|cfg|conf|html?|xml|csv|tsv|log|diff|patch', 'json|ya?ml'],
  ['extensionless coverage', 'const NO_EXT_RE = /(^|\\/)\\.?[^./]+$/;', 'const NO_EXT_RE = /$^/;'],
  ['the whole content check', 'for (const m of CONTENT_MARKERS) {', 'for (const m of []) {'],
  ['the whole path check', 'for (const p of FORBIDDEN_PATHS) {', 'for (const p of []) {'],
  ['the empty-index UNKNOWN guard', "unknown: true, reason: 'git ls-files returned no tracked files (empty index)'", "unknown: false, ok: true, scanned: 0, read: 0"],
  // THE EXIT-CODE LAYER. Everything else mutates scan(); these mutate what a hook actually
  // reads. Without them a gate could print every finding and still exit 0, with --selftest
  // green and this harness at full marks.
  ['exit code for findings', "  return 1;\n}", "  return 0;\n}"],
  ['exit code for UNKNOWN', '    return 2;', '    return 0;'],
  // Per-format coverage: one dropped extension is one invisible leak class.
  // Each anchor carries a neighbour so it is unique to CONTENT_EXT_RE. OUTPUT_EXT_RE lists many
  // of the same formats, and the bare forms (`html?|`, `csv|tsv|`, `|log|`) matched there FIRST,
  // so these four mutations were editing the wrong regex entirely.
  ['html coverage', 'conf|html?|', 'conf|'],
  ['csv coverage', 'xml|csv|tsv|', 'xml|'],
  ['log coverage', 'tsv|log|diff', 'tsv|diff'],
  // The UNKNOWN path must still name what it already found.
  ['findings printed under UNKNOWN', "for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);", ''],
  // Case-insensitivity of the directory rule.
  ['directory rule case-insensitivity', "pass-\\d+$/i", "pass-\\d+$/"],
  // THE SOURCE-ROOT NAME SIGNAL. Without it, third-party trees are flagged with a delete remedy.
  ['source-root name signal',
    'if (segs.slice(0, idx).some((s) => SOURCE_ROOT_NAME_RE.test(s))) continue;', ''],
  // ITS SCOPE. Testing the WHOLE path instead of only the segments ABOVE the pass directory lets
  // `design/refine-pass-4/spec/*.png` exonerate itself.
  ['source-root name scoped above the pass dir',
    'segs.slice(0, idx).some((s) => SOURCE_ROOT_NAME_RE.test(s))',
    'segs.some((s) => SOURCE_ROOT_NAME_RE.test(s))'],
  // THE OUTPUT SIGNAL - the only evidence that can raise a finding. Without it nothing ever
  // reaches the floor, so every real leak reports CLEAN.
  //
  // DISABLE THE TEST, DO NOT DELETE THE LINE. This anchor is the `if` head of an if/else-if pair,
  // so replacing it with nothing left a dangling `else` and the mutant did not parse. node exits
  // non-zero on a SyntaxError, the verdict rule below reads any non-zero as CAUGHT, and so the
  // mutation for the ONLY line that can raise a finding was scored as proof while running zero
  // controls: measured at 83ms with no SELFTEST FAIL line on either stream. `if (false)` keeps the
  // pair intact and really does disable the signal - every png then counts as unrecognised, no
  // directory reaches the floor, and every dir-rule fixture expecting `fail` turns red.
  ['pass-dir output signal', 'if (STRONG_OUTPUT_EXT_RE.test(base)) e.strong++;', 'if (false) e.strong++;'],
  // THE FLOOR. Review 2026-07-27 proved the threshold had NO control on either side, so the
  // comparison could be moved freely without turning the suite red. Dropping it to 1 restores the
  // over-report direction, where a single stray screenshot makes a code directory a finding.
  ['pass-dir output floor', 'e.strong < PASS_DIR_MIN_OUTPUT', 'e.strong < 1'],
  // MEMBERSHIP OF THE OUTPUT LIST, which is the new primary discriminator and was completely
  // untested except for png. Both formats below were MEASURED reporting CLEAN on v6 while the
  // directory really was pipeline output.
  ['pass-dir output list: jsonl', 'ndjson|jsonl|zip', 'ndjson|zip'],
  ['pass-dir output list: sarif', 'har|trace|sarif|log', 'har|trace|log'],
  // THE FURNITURE LIST. If a genuinely neutral format stops abstaining it becomes UNRECOGNISED,
  // which silently downgrades a confident finding to advisory - i.e. it changes what the operator
  // is told to DO, while the verdict stays identical and a verdict-only control sees nothing.
  ['pass-dir neutral list', 'md|markdown|txt|json|jsonc', 'md|markdown|txt|jsonc'],
  // THE CONFIDENCE DECISION ITSELF, in both directions. This branch decides whether the operator
  // is handed `git rm -r --cached` or "go and look", so it is the most dangerous thing here.
  ['pass-dir confidence', 'const confident = e.unrecognised === 0;', 'const confident = true;'],
  // NAMING ONLY THE ARTIFACTS, in BOTH grades. Listing somebody's source file or their
  // package.json under an untrack heading is exactly how a finding gets acted on as an
  // instruction. The anchor lost its `confident ||` arm on 2026-07-27, when the confident grade
  // stopped naming the whole directory as a unit; the mutation is the same shape either way.
  ['pass-dir file scope',
    'if (STRONG_OUTPUT_EXT_RE.test(f.slice(f.lastIndexOf(\'/\') + 1))) {',
    'if (true) {'],
  // KEYING ON THE INNERMOST PASS SEGMENT. Keying on the outermost merges nested pass directories
  // into one bucket, where they exonerate each other.
  ['pass-dir innermost key', 'const key = segs.slice(0, lastIdx + 1).join(\'/\');',
    'const key = segs.slice(0, idx + 1).join(\'/\');'],
  // THE SEPARATOR IN THE SEGMENT PATTERN. Dropping the required hyphen makes `bypass-2`,
  // `multipass-3` and `compass-3` match, which is the destructive direction.
  ['pass-segment separator', "/^(?:[a-z0-9._-]+-)?pass-\\d+$/i", "/^(?:[a-z0-9._-]+)?pass-\\d+$/i"],
  // ANCHORING THE SEGMENT. Without the end anchor a directory merely CONTAINING the shape
  // matches, and without the start anchor the segment test stops being a segment test.
  ['pass-segment end anchor', "?pass-\\d+$/i", "?pass-\\d+/i"],
  // SIZE MEASUREMENT, one mutation per direction, because the ASCII oversize fixture cannot tell
  // the three measurements apart and left the byte accounting entirely unproven.
  // A: back to measuring the DECODE, which inflates non-UTF-8 bytes threefold.
  ['size measured on the file, not the decode',
    'if (buf.length > MAX_BYTES) {',
    "if (Buffer.byteLength(buf.toString('utf8'), 'utf8') > MAX_BYTES) {"],
  // B: back to UTF-16 code units, which under-counts every multi-byte alphabet.
  ['size measured in bytes, not UTF-16 units',
    'if (buf.length > MAX_BYTES) {',
    "if (buf.toString('utf8').length > MAX_BYTES) {"],
  // json is the format the estate actually leaked (review dumps), and it had no content control.
  // `tex|` prefix so this cannot match OUTPUT_EXT_RE's `json|ndjson` instead.
  ['json coverage', 'tex|json|ndjson', 'tex|ndjson'],
  // The formats whose twins were already covered while they were not (.jsonl beside .ndjson,
  // .jsonc beside .json, .svg beside .xml), plus .har and .trace, which the DIRECTORY rule calls
  // unambiguous pipeline output while the CONTENT scan never read them.
  ['late content coverage group', 'patch|jsonl|jsonc|svg|har|trace|lock', 'patch'],
  // THE REMEDY LAYER. Everything above mutates what the gate DECIDES; these two mutate what it
  // TELLS THE OPERATOR TO DO, which had no control until now. That gap is how the pass-directory
  // remedy came to read "you can untrack it" about a directory the gate cannot classify: the
  // verdict and the exit code were both right, so nothing observed the instruction attached to them.
  ['pass-dir remedy demands confirmation',
    "console.error('CONFIRM BEFORE UNTRACKING: open the directory, satisfy yourself it is pipeline');",
    "console.error('');"],
  // Scoping each remedy to its own finding type. Unconditional again, a run whose only findings are
  // pass-numbered directories opens with "untrack them", which is read as the remedy for them.
  ['remedy scoped to its finding type',
    'if (res.findings.some((f) => /^forbidden path/.test(f.why))) {',
    'if (true) {'],
  // The THIRD remedy branch, which had neither a control nor a mutation while the other two had
  // both. A branch nothing can observe is the gap this whole layer exists to close.
  //
  // TWO mutations, because the first pair pinned the TEXT and left the CONDITION unobservable:
  // deleting the paragraph was caught, making it print unconditionally was NOT, and the suite
  // stayed at 138 ok / exit 0 while a comment claimed the branch was covered. The text mutation
  // is the deletion direction; the condition mutation is the inversion direction. Every remedy
  // control now asserts the exact SET of blocks printed, so both directions fail.
  ['content remedy text',
    "console.error('CONTENT hits need a JUDGEMENT, not a reflex. If the file is a genuine product');",
    "console.error('');"],
  ['content remedy scoped to its finding type',
    'if (res.findings.some((f) => /^content:/.test(f.why))) {',
    'if (true) {'],
  // ALL THREE remedy CONDITIONS carry a mutation, not two of three. Its controls do exist and do
  // fail on it, which is why it never showed up as an escape - but a control with no mutation is a
  // control nothing checks for rot, and this is precisely the layer where a condition was last
  // found pinned by text alone.
  //
  // SCOPE OF THAT CLAIM, corrected: walking every decision in the production path against this list
  // leaves TWO others with no entry either, and an earlier version of this comment said the
  // pass-directory condition was the only one, which was simply false. The other two are
  // `if (res.ok)` (covered by the clean-repo exit control, no mutation) and the findings dedupe
  // `if (seen.has(k))` (no control found). Both are left uncovered on purpose: breaking the dedupe
  // yields duplicate report lines, never a false clean and never a false delete, so it cannot
  // produce either failure this gate exists to prevent. Say what is uncovered rather than implying
  // nothing is.
  ['pass-dir remedy scoped to its finding type',
    'if (res.findings.some((f) => /pass-numbered directory/.test(f.why))) {',
    'if (true) {'],
];

const dir = mkdtempSync(join(tmpdir(), 'ship-artifacts-mutants-'));
let escaped = 0, skipped = 0, inconclusive = 0, selected = 0;
try {
  for (const [name, find, repl] of MUTATIONS) {
    if (ONLY && !name.toLowerCase().includes(ONLY)) continue;
    selected++;
    const hits = src.split(find).length - 1;
    if (hits === 0) { console.log(`  SKIP    ${name} (anchor not found - update this harness)`); skipped++; continue; }
    // AN AMBIGUOUS ANCHOR IS WORSE THAN A MISSING ONE. `String.replace` with a string pattern
    // substitutes only the FIRST occurrence, so a two-hit anchor silently mutates something other
    // than the rule it is named after and then reports ESCAPED for a control that is fine.
    // Measured: adding OUTPUT_EXT_RE gave `|log|`, `|csv|`, `html?|xml` and `|json|` a second home,
    // and four format mutations quietly started editing the wrong regex. A missing anchor is loud;
    // this was not, which is why it gets its own hard failure rather than a skip.
    if (hits > 1) {
      skipped++;
      console.log(`  AMBIGUOUS ${name} (anchor occurs ${hits} times - it would mutate only the first; make it unique)`);
      continue;
    }
    const mutant = join(dir, `m${MUTATIONS.findIndex(m => m[0] === name)}.mjs`);
    writeFileSync(mutant, src.replace(find, repl));
    // THE HARNESS MUST TRAVEL WITH THE MUTANT, or this whole tool silently stops working.
    //
    // The gate's layer-B self-reference control reads `./check-ship-artifacts.mutants.mjs`
    // RELATIVE TO ITSELF. A mutant written alone into a temp dir therefore never finds it and
    // ALWAYS prints "selftest SKIPPED: mutants harness source not readable beside the gate".
    // Once skipped runs were reclassified as inconclusive, that matched EVERY mutant, so every
    // exit-0 child -- which is the definition of an ESCAPE -- was swallowed as inconclusive and
    // subtracted from the denominator. Proven with a NO-OP mutation: it reported "NO VERDICT",
    // never "ESCAPED", and the summary read "1 attempted, 1 inconclusive". A mutation harness
    // that cannot report an escape is worse than none, because its number is quoted as proof.
    //
    // Copying it beside the mutant removes the skip at its source, so any SKIPPED that remains
    // is a real one rather than an artefact of how this harness stages its own mutants.
    writeFileSync(join(dir, 'check-ship-artifacts.mutants.mjs'), selfSrc);
    // A MUTANT THAT DOES NOT PARSE IS NOT A MUTATION TEST, and nothing below can tell the two
    // apart: node exits non-zero on a SyntaxError exactly as it does on a caught mutation, so the
    // `code === 0` rule scores a file that never executed a single control as CAUGHT. That is the
    // most dangerous failure this harness has, because it inflates the numerator of the number
    // this whole tool exists to produce. Measured on the `pass-dir output signal` anchor, which is
    // the `if` head of an if/else-if pair: deleting it left a dangling `else`, the mutant died in
    // 83ms with zero SELFTEST FAIL lines, and the sweep reported CAUGHT.
    //
    // Checking the parse FIRST separates "the rule has a control" from "the mutation was malformed".
    try {
      execFileSync(process.execPath, ['--check', mutant], { windowsHide: true, stdio: 'pipe' });
    } catch (e) {
      skipped++;
      const why = String((e && e.stderr) || '').split('\n').find((l) => /Error/.test(l)) || 'parse failed';
      console.log(`  UNPARSEABLE ${name} (the mutated source is not valid JS: ${why.trim()})` +
        ' - the mutation is malformed, not the rule; rewrite it to produce valid code');
      continue;
    }
    let code = 0, noVerdict = '', out = '', err = '';
    try {
      out = execFileSync(process.execPath, [mutant, '--selftest'], { encoding: 'utf8', windowsHide: true, timeout: 600000, stdio: 'pipe' }) || '';
    } catch (e) {
      // A KILLED run never produced a verdict. `e.status` is null for a signal kill, and mapping
      // that to -1 fed "non-zero means caught", so a kill was reported as proof this harness does
      // not have. Same class of bug as a connection error counted as a passing guard: the absence
      // of an answer is not an answer.
      //
      // ON THE TIMEOUT, stated accurately at the third attempt. The per-child limit was 300s when
      // the ten-minute overrun happened, and a mutant costs roughly 110-140s (re-measured
      // 2026-07-27 across four runs; the earlier "53-85s" here was never re-checked after the
      // suite grew), so no CHILD was ever near it. What exceeded ten minutes was the HARNESS
      // process itself - a full sweep runs well over an hour, which is what
      // `--only` exists for. Raising the child timeout never addressed that; it was raised to
      // 600000 anyway in 5379592 and is left there as headroom, which is why the line above says
      // 600000 and not 300000. Run this in the background. The kill branch below is still
      // reachable and still correct, it is simply not what happened that day.
      if (e.killed || e.signal) noVerdict = e.signal ? `killed by ${e.signal}` : 'timed out';
      else code = e.status == null ? -1 : e.status;
      out = String((e && e.stdout) || '');
      // STDERR TOO. `SELFTEST FAIL` is printed with console.error, so a stdout-only read sees ZERO
      // failed controls on a run where thirty fired, and the check below would then call every
      // real catch inconclusive. This is the same stderr trap the gate itself keeps setting.
      err = String((e && e.stderr) || '');
    }
    const both = out + err;
    if (noVerdict) { inconclusive++; console.log(`  NO VERDICT ${name} (${noVerdict}; see the timeout note above)`); }
    else if (code === 0) {
      // AN ESCAPE IS STILL AN ESCAPE, even if some unrelated control was skipped.
      //
      // A skip used to demote this to inconclusive, which read as caution but was the opposite:
      // it once made ESCAPED unreachable for EVERY mutation, and a single legitimate skip (the
      // submodule control on a git that refuses local submodules) would do it again. So report
      // the escape - the fail-toward-showing-a-gap direction - and carry the skip alongside it,
      // rather than letting an unrelated skip suppress the finding.
      const skips = (both.match(/selftest SKIPPED/gi) || []).length;
      escaped++;
      console.log(`  ESCAPED ${name}` + (skips ? `  (NB ${skips} control(s) skipped in that run; confirm one of them is not the control for this rule)` : ''));
    } else {
      // A NON-ZERO EXIT IS NOT A CATCH. It only becomes one if a CONTROL actually failed.
      //
      // The parse guard above closes the SyntaxError door; this closes the rest of the corridor,
      // and it is the half of the fix that was left out the first time. Anything that makes the
      // mutant die before or outside the suite exits non-zero exactly as a caught mutation does.
      // Measured: a mutant that merely called process.exit(7) was reported CAUGHT, "1/1 mutations
      // caught", harness exit 0, in 1.0s against a real mutant cost of 110-140s; so was one that
      // threw a ReferenceError at module scope.
      //
      // That door is not hypothetical here. fixture() throws when a case fails to stage what it
      // wrote, and its signature is exactly this: exit 1, zero failed controls. So the guard
      // protecting the fixtures could have been silently converting every mutation into a false
      // CAUGHT, which is the one failure mode that inflates the number this tool exists to produce.
      //
      // Duration is not usable as the signal - a fast mutant is not necessarily a broken one - but
      // a run in which NO control failed has, by definition, demonstrated nothing about controls.
      // `SELFTEST FAIL: ` WITH THE COLON. Without it this also matched the gate's summary line,
      // `[ship-artifacts] SELFTEST FAILED (n)`, so every count printed below was exactly one too
      // high and `(1 control(s) failed)` was unreachable - the fingerprint that gave it away. The
      // verdict was never wrong, because that summary prints only when n is above zero, but a
      // whole sweep log of inflated numbers was quoted as fact within hours of being produced.
      // Every per-control failure is printed as `SELFTEST FAIL: <name> -> <problem>`; the summary
      // says FAILED and carries no colon.
      const failures = (both.match(/SELFTEST FAIL: /g) || []).length;
      if (failures === 0) {
        inconclusive++;
        console.log(`  NO VERDICT ${name} (exited ${code} without failing a single control - the ` +
          'mutant died before or outside the suite, so this proves nothing about that rule)');
      } else console.log(`  CAUGHT  ${name}  (${failures} control(s) failed)`);
    }
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Only mutations that actually returned a verdict are counted as caught. An inconclusive run is
// subtracted from the denominator rather than quietly inflating the numerator.
// The denominator is what was SELECTED, not MUTATIONS.length: under `--only` those differ, and a
// filtered run must never report a total it did not attempt.
const total = selected - skipped - inconclusive;
if (ONLY) console.log(`\n(--only "${ONLY}": ${selected} of ${MUTATIONS.length} mutation(s) selected)`);
if (selected === 0) {
  console.log(`\nNO MUTATION MATCHED --only "${ONLY}". Nothing ran, so nothing was proven.`);
} else if (total <= 0) {
  // "0/0 mutations caught" is a headline that reads like a clean sweep of an empty set. Say what
  // actually happened: nothing was proven.
  console.log(`\nNO MUTATION PRODUCED A VERDICT: ${selected} attempted, ` +
    `${skipped} skipped (anchor drift), ${inconclusive} inconclusive.`);
  console.log('This run proves NOTHING about the controls. Do not read it as a pass.');
} else {
  console.log(`\n${total - escaped}/${total} mutations caught` +
    (skipped ? ` (${skipped} skipped)` : '') +
    (inconclusive ? ` (${inconclusive} inconclusive - NOT counted as caught)` : ''));
}
if (escaped) console.error('An escaped mutation means that rule has no control that can fail. Fix the selftest.');
if (skipped) console.error('A skipped mutation proved nothing about its rule: the anchor was missing, ' +
  'ambiguous, or produced source that does not parse. Fix the MUTATION, not the gate.');
if (inconclusive) console.error('An inconclusive mutation produced NO verdict. This run does not prove those controls work.');
// `selected === 0` exits 1 too: a `--only` that matched nothing ran no mutation at all, and an
// exit 0 there would read exactly like a clean sweep of every control.
process.exit(selected === 0 || escaped || skipped || inconclusive ? 1 : 0);
