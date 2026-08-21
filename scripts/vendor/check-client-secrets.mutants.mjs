#!/usr/bin/env node
// check-client-secrets.mutants.mjs - prove the gate's --selftest controls are NON-VACUOUS.
//
// Each mutation disables exactly ONE rule of check-client-secrets.mjs; the gate's own --selftest
// must then go RED. A mutation that leaves --selftest GREEN is an ESCAPE: it means the control
// named after that rule asserts nothing, which is the "a passing suite proved nothing" failure the
// scaffold-gates carry mutant harnesses to catch. This file exits non-zero on any escape.
//
// Usage:  node scripts/check-client-secrets.mutants.mjs
// Exit codes: 0 all mutations caught, 1 an escape, 2 baseline gate selftest is not green.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'check-client-secrets.mjs');
const src = readFileSync(SRC, 'utf8');

// find must be a UNIQUE substring of the gate source; repl disables that one rule.
//
// `expect` NAMES the control this mutation must turn red, and it is the whole point rather than
// documentation. Without it the check was "did SOME control go red", which is far weaker than it
// reads: the fixtures share payloads heavily (disabling the Stripe rule reddens ten controls), so
// a rule whose OWN control had been deleted still scored as caught off a neighbour's control, and
// the harness printed full two-directional coverage for a rule nothing tested. Proven by deleting
// the `deny: GitHub token` control outright: 33/33 caught, all controls proven, exit 0.
// Adding a mutation without an `expect` is refused below rather than silently weakened.
const MUTATIONS = [
  { name: 'service_role role discrimination', expect: 'deny: Supabase service_role JWT', find: "jwtRole(m[0]) === 'service_role'", repl: "jwtRole(m[0]) === '__disabled__'" },
  { name: 'anon over-flag guard (only service_role, not every JWT)', expect: 'public-by-design keys pass (anon JWT + Firebase web + Stripe pk)', find: "if (jwtRole(m[0]) === 'service_role') {", repl: "if (jwtRole(m[0]) !== '__never__') {" },
  { name: 'Stripe secret deny regex', expect: 'deny: Stripe secret key', find: '/\\bsk_(?:live|test)_[0-9A-Za-z]{16,}/', repl: '/\\bZZNEVER_sk_(?:live|test)_[0-9A-Za-z]{16,}/' },
  { name: 'PEM private key deny regex', expect: 'deny: PEM private key', find: '/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/', repl: '/-----ZZNEVERBEGIN PRIVATE KEY-----/' },
  { name: 'auto-detect no-bundle UNKNOWN (false-clean guard)', expect: 'auto-detect with no build dir is UNKNOWN, not clean', find: 'unknown: true, reason: `no built client bundle found', repl: 'unknown: false, ok: true, reason: `no built client bundle found' },
  { name: 'explicit missing-dir UNKNOWN (false-clean guard)', expect: 'an explicit missing dir is UNKNOWN, not clean', find: 'unknown: true, reason: `requested dir does not exist', repl: 'unknown: false, ok: true, reason: `requested dir does not exist' },
  { name: 'scans non-JS bundle files (binary-denylist, not a text-allowlist)', expect: 'an inline secret in an .svg (text) is scanned', find: 'names.some((n) => !BINARY_EXT_RE.test(n))', repl: '/\\.js$/.test(name)' },
  { name: 'symlink name filters judge the TARGET too, not only the link name', expect: 'a binary-NAMED symlink to a secret file is still scanned', find: 'name = basename(realpathSync(p));', repl: 'name = ent.name;' },
  // The MIRROR of the mutation above, and the regression it exists to prevent. `only` is an
  // ALLOWLIST, so judging it by the target ALONE drops a browser-shipped link whose target has no
  // extension. Either-name is the invariant; this proves the `ent.name` half is load-bearing.
  { name: 'the browser-shipped allowlist accepts EITHER name (else an extensionless target is dropped)', expect: 'a browser-shipped symlink to an EXTENSIONLESS target is still scanned', find: 'names.some((n) => only.test(n))', repl: 'only.test(name)' },
  { name: 'Supabase sb_secret_ deny regex', expect: 'deny: Supabase sb_secret_ (new key format)', find: '/\\bsb_secret_[A-Za-z0-9_-]{16,}/', repl: '/\\bZZNEVER_sb_secret_[A-Za-z0-9_-]{16,}/' },
  { name: 'symlink resolution (else a symlinked secret is skipped)', expect: 'a symlinked secret file is scanned, not skipped', find: 'if (ent.isSymbolicLink()) {', repl: 'if (false && ent.isSymbolicLink()) {' },
  { name: 'AWS ASIA temp-credential alternation', expect: 'deny: AWS temp ASIA credential', find: '/\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b/', repl: '/\\b(?:AKIA)[0-9A-Z]{16}\\b/' },
  { name: 'GitHub fine-grained PAT deny regex', expect: 'deny: GitHub fine-grained PAT (github_pat_)', find: '/\\bgithub_pat_[A-Za-z0-9_]{22,}/', repl: '/\\bZZNEVER_github_pat_[A-Za-z0-9_]{22,}/' },
  { name: 'Slack token deny regex', expect: 'deny: Slack token', find: '/\\bxox[baprs]-[0-9A-Za-z-]{10,}/', repl: '/\\bZZNEVERxox[baprs]-[0-9A-Za-z-]{10,}/' },
  { name: 'SendGrid deny regex', expect: 'deny: SendGrid API key', find: '/\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}/', repl: '/\\bZZNEVER_SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}/' },
  { name: 'PEM ENCRYPTED variant', expect: 'deny: PEM ENCRYPTED private-key variant', find: '|PGP |ENCRYPTED )?PRIVATE KEY', repl: '|PGP )?PRIVATE KEY' },
  { name: 'Stripe RESTRICTED key deny regex', expect: 'deny: Stripe RESTRICTED key (rk_)', find: '/\\brk_(?:live|test)_[0-9A-Za-z]{16,}/', repl: '/\\bZZNEVER_rk_(?:live|test)_[0-9A-Za-z]{16,}/' },
  { name: 'Google service-account private_key FIELD regex', expect: 'deny: Google service-account private_key FIELD (header the PEM rule misses)', find: '/"private_key"\\s*:\\s*"-----BEGIN/', repl: '/"ZZNEVERprivate_key"\\s*:\\s*"-----BEGIN/' },
  { name: 'UTF-16 decoding (else a UTF-16 bundle file is mojibake and matches nothing)', expect: 'a UTF-16LE bundle file is decoded, not read as mojibake', find: "return buf.includes(0) ? ['utf8', 'utf16le', 'utf16be'] : ['utf8'];", repl: "return ['utf8'];" },
  { name: 'UTF-16 BIG-endian odd-length handling (else an odd BE file is unscanned)', expect: 'an ODD-length UTF-16BE file is still scanned', find: 'const even = b.length % 2 === 0 ? b : b.subarray(0, b.length - 1);', repl: 'const even = b.length % 2 === 0 ? b : b.subarray(0, 0);' },
  { name: 'PER-CHUNK decoder choice (else an ASCII first chunk blinds the rest of the file)', expect: 'an ASCII first chunk does not disable UTF-16 decoding later', find: 'for (const name of decoderNamesFor(chunk)) {', repl: "for (const name of decoderNamesFor(Buffer.from('a'))) {" },
  { name: 'full data-URI carry across a chunk boundary', expect: 'a data URI LONGER than the overlap, straddling a boundary', find: 'if (carry > overlap && carry <= MAX_URI_CARRY) return text.slice(idx);', repl: 'if (false) return text.slice(idx);' },
  { name: '--selftest refuses a directory (else it exits 0 having scanned nothing)', expect: '--selftest with a directory is refused, not silently run', find: '    if (dirs.length) {', repl: '    if (false && dirs.length) {' },
  { name: 'unknown-flag guard (its control was VACUOUS until the fixture named a clean dir)', expect: 'an unknown flag is refused, even when the scan would have succeeded', find: '  if (unknownFlags.length) {', repl: '  if (false && unknownFlags.length) {' },
  { name: 'data-URI quantifier BOUNDS (else the pattern backtracks quadratically)', expect: 'a long non-matching data: run does not backtrack', find: 'text\\/[a-z0-9.+-]{1,64})(?:;[a-z0-9.=+-]{1,64}){0,8}', repl: 'text\\/[a-z0-9.+-]+)[a-z0-9;=.+-]*' },
  // The nine below close a REVERSE-coverage gap: their controls existed but no mutation could turn
  // them red, so nothing was checking whether they still asserted anything. A mutation harness only
  // ever validates mutation -> control, so a control without a mutation is invisible to it. That is
  // not hypothetical: the unknown-flag control was vacuous for exactly this reason. When you add a
  // control, add the mutation that reddens it in the same change.
  { name: 'OpenAI/Anthropic deny regex', expect: 'deny: OpenAI/Anthropic-style key', find: '(?:ant-)?[A-Za-z0-9_-]{20,}', repl: 'ZZNEVER(?:ant-)?[A-Za-z0-9_-]{20,}' },
  { name: 'AWS AKIA branch (the ASIA mutation only ever proved the ASIA control)', expect: 'deny: AWS access key id', find: '/\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b/', repl: '/\\b(?:ZZNEVERAKIA|ASIA)[0-9A-Z]{16}\\b/' },
  { name: 'GitHub classic token deny regex', expect: 'deny: GitHub token', find: '/\\bgh[pousr]_[A-Za-z0-9]{36,}/', repl: '/\\bZZNEVERgh[pousr]_[A-Za-z0-9]{36,}/' },
  { name: 'UNKNOWN-with-no-findings exits 2', expect: 'an incomplete scan with NO findings exits 2', find: "Refusing to report clean on a scan that did not run.');\n    return 2;", repl: "Refusing to report clean on a scan that did not run.');\n    return 0;" },
  { name: 'a clean scan exits 0', expect: 'a clean complete scan exits 0', find: 'client file(s) scanned)`);\n    return 0;', repl: 'client file(s) scanned)`);\n    return 2;' },
  { name: 'a found secret exits 1', expect: 'a found secret in a complete scan exits 1', find: '\n  return 1;\n}', repl: '\n  return 0;\n}' },
  { name: 'base64 data-URI decoding', expect: 'a base64 data-URI hiding a service-account key is decoded and caught', find: '/data:(?:application\\/(?:json|xml|x-yaml|yaml)', repl: '/ZZNEVERdata:(?:application\\/(?:json|xml|x-yaml|yaml)' },
  { name: 'chunk OVERLAP (else a key straddling a chunk boundary is invisible)', expect: 'a key STRADDLING a chunk boundary is still caught (overlap)', find: 'tails.set(name, tailOf(text, overlap));', repl: "tails.set(name, '');" },
  { name: 'chunk iteration (else only the first chunk of a big file is scanned)', expect: 'an oversized file is CHUNK-scanned, not called unreadable', find: 'pos += n;', repl: 'pos = size;' },
  { name: 'findings-before-unknown exit ordering (else a found secret exits 2, not 1)', expect: 'a found secret in an INCOMPLETE scan exits 1, not 2', find: 'if (found === 0 && res.unknown) {', repl: 'if (res.unknown) {' },
  { name: 'Next.js pre-rendered pages are auto-detected (else .next/static alone reports clean)', expect: "a Next.js pre-rendered page's __NEXT_DATA__ is scanned", find: "'.next/server/pages', '.next/server/app',", repl: "'ZZNEVER/server/pages', '.next/server/app'," },
  { name: 'browser-shipped-only restriction (else legitimate SERVER secrets are flagged)', expect: 'Next.js SERVER code beside it is NOT flagged', find: 'only: /\\.(html?|rsc|json|body)$/i', repl: 'only: /\\./i' },
  { name: '.body is browser-shipped (a static Route Handler response body)', expect: 'a static Route Handler .body is scanned', find: '|rsc|json|body)$/i', repl: '|rsc|json)$/i' },
  { name: 'restriction matches a path SUFFIX (else only a bare project-root .next is restricted)', expect: 'an explicitly passed monorepo .next/server/pages is restricted', find: '/(^|\\/)\\.next\\/server(\\/|$)/i', repl: '/^\\.next\\/server\\/(pages|app)$/' },
  { name: 'restriction covers the WHOLE .next/server tree, not just pages and app', expect: 'a typed .next/server restricts its whole tree', find: '{ dir: /(^|\\/)\\.next\\/server(\\/|$)/i,', repl: '{ dir: /(^|\\/)\\.next\\/server\\/(pages|app)(\\/|$)/i,' },
  { name: 'case-insensitive path match', expect: 'an UPPERCASE .NEXT path is the same directory', find: '\\.next\\/server(\\/|$)/i, only:', repl: '\\.next\\/server(\\/|$)/, only:' },
  { name: 'separator-run collapsing in the normaliser', expect: 'doubled separators are the same directory', find: ".replace(/\\/+/g, '/')", repl: '' },
  { name: '.next itself is NOT matched (else client chunks stop being scanned: a FALSE CLEAN)', expect: 'a key in .next/static is STILL caught when .next is passed', find: '{ dir: /(^|\\/)\\.next\\/server(\\/|$)/i, only:', repl: '{ dir: /(^|\\/)\\.next(\\/|$)/i, only:' },
  { name: 'seen-key includes the restriction (else a symlink alias hides a client dir)', expect: 'a symlink aliasing a client dir under .next/server does not hide it', find: "const key = `${real} ${only ? only.source : ''}`;", repl: 'const key = real;' },
  { name: 'file list is de-duplicated by RESOLVED path (else the count counts visits, not files)', expect: 'a file reachable twice is counted once', find: 'if (seenFiles.has(realFile)) continue;', repl: 'if (false) continue;' },
  // One mutation PER SCHEME. A single mutation over the alternation proved almost nothing: killing
  // only the `redis` branch left Postgres matching, so the entry named for Postgres went green
  // while an unrelated control went red. The harness reported it as an escape naming both, which
  // is exactly what the expect binding is for.
  { name: 'connection-string: postgres scheme', expect: 'deny: Postgres URL carrying a password', find: '(?:postgres(?:ql)?|mysql', repl: '(?:ZZNEVERpostgres|mysql' },
  { name: 'connection-string: mysql scheme', expect: 'deny: MySQL URL carrying a password', find: '|mysql|mongodb', repl: '|ZZNEVERmysql|mongodb' },
  { name: 'connection-string: mongodb scheme', expect: 'deny: MongoDB SRV URL carrying a password', find: 'mongodb(?:\\+srv)?', repl: 'ZZNEVERmongodb' },
  { name: 'connection-string username is OPTIONAL (else Redis, which omits it, is missed)', expect: 'deny: Redis URL with NO username but a password', find: "clickhouse):\\/\\/[^\\s@/\"'`]*:", repl: "clickhouse):\\/\\/[^\\s@/\"'`]+:" },
  { name: 'connection-string requires a PASSWORD (else every credential-free URL is flagged)', expect: 'a credential-FREE connection string is not flagged', find: "clickhouse):\\/\\/[^\\s@/\"'`]*:[^\\s@/\"'`]+@", repl: "clickhouse):\\/\\/" },
  // The quoted rule's field list is FAMILIES of secret-intent names, one mutation per family so a
  // disabled family cannot hide behind a neighbour. Anchors lean on arms only the QUOTED rule has
  // (the unquoted rule shares password/passwd/pwd, so those anchors include an adjacent
  // quoted-only arm to stay unique - the ambiguity check refused the bare form once already).
  { name: 'generic credential: the *secret family', expect: 'deny: generic clientSecret assignment', find: '(?:[a-z0-9_-]*secret|', repl: '(?:ZZNEVERxsecret|' },
  { name: 'generic credential: the secretKey arm', expect: 'deny: generic secretKey assignment', find: '|secret[_-]?key|private', repl: '|ZZNEVERsecretkey|private' },
  { name: 'generic credential: the privateKey arm', expect: 'deny: generic privateKey assignment', find: '|private[_-]?key|password', repl: '|ZZNEVERprivatekey|password' },
  { name: 'generic credential: the password family', expect: 'a password of changeme... is a real weak password, not a placeholder', find: '|password|passwd|pwd|auth[_-]?token', repl: '|ZZNEVERpassword|auth[_-]?token' },
  { name: 'generic credential: the token family (auth/access/refresh)', expect: 'deny: generic refresh_token assignment', find: '|auth[_-]?token|access[_-]?token|refresh[_-]?token)', repl: '|ZZNEVERtokens)' },
  // THE NARROWING, mutated in the widening direction: putting apiKey and bare token back must
  // redden the public-analytics controls, or the field list could quietly re-widen and every
  // Firebase and PostHog app would be flagged again.
  { name: 'quoted rule excludes apiKey and bare token (else public analytics keys are flagged)', expect: 'a public analytics apiKey assignment is not flagged (apiKey is not a secret-intent field)', find: '(?:[a-z0-9_-]*secret|secret[_-]?access', repl: '(?:api[_-]?key|apikey|token|[a-z0-9_-]*secret|secret[_-]?access' },
  // The AWS arm, once per rule it lives in. The anchors carry a neighbour unique to each rule
  // (the quoted list has `|secret[_-]?key` after it, the unquoted list has `apikey|` before it),
  // because the arm text itself now appears twice in the gate.
  { name: 'the secret_access_key arm, quoted rule', expect: 'deny: AWS-style secretAccessKey assignment', find: '|secret[_-]?access[_-]?key|secret[_-]?key', repl: '|ZZNEVERsak|secret[_-]?key' },
  { name: 'the secret_access_key arm, unquoted rule', expect: 'deny: unquoted aws_secret_access_key line', find: 'apikey|secret[_-]?access[_-]?key|secret', repl: 'apikey|ZZNEVERsak|secret' },
  // The whitespace suppressor. Removing it must redden the UI-text control, or password-named
  // i18n tables in every built bundle become findings and the gate cries wolf.
  { name: 'whitespace in a value means UI text, not a credential', expect: 'login-form UI text in password-named fields is NOT flagged', find: "FAKE_VALUE_RE.source + '|\\\\s'", repl: 'FAKE_VALUE_RE.source' },
  { name: 'unquoted credential assignment (Azure-style, .env line)', expect: 'deny: Azure-style unquoted AccountKey', find: '(?:account_?key|api[_-]?key', repl: '(?:ZZNEVERaccountkey|api[_-]?key' },
  { name: 'credentials in an http(s) URL', expect: 'deny: credentials embedded in an http(s) URL', find: '\\bhttps?:\\/\\/[^\\s:@/"\'`]+:', repl: '\\bZZNEVERhttps?:\\/\\/[^\\s:@/"\'`]+:' },
  { name: 'the http(s) URL rule requires a PASSWORD (else every ordinary URL is flagged)', expect: 'a credential-FREE connection string is not flagged', find: 'https?:\\/\\/[^\\s:@/"\'`]+:[^\\s:@/"\'`]+@', repl: 'https?:\\/\\/' },
  // THE ALLOW LIST. Each arm gets its own mutation, because each exempts a different public key and
  // a single mutation over the function would prove only whichever control happened to redden.
  { name: 'allow list: the Firebase web key arm', expect: 'a Firebase web key in an unquoted config is public, not a finding', find: 'if (PUBLIC_FIREBASE_RE.test(value)) return true;', repl: 'if (false) return true;' },
  { name: 'allow list: the Stripe publishable arm', expect: 'a Stripe publishable key in an unquoted config is public, not a finding', find: 'if (PUBLIC_STRIPE_PK_RE.test(value)) return true;', repl: 'if (false) return true;' },
  { name: 'allow list: an ANON JWT is exempt', expect: 'an anon JWT in an access_token assignment is public, not a finding', find: "if (JWT_VALUE_RE.test(value)) return jwtRole(value) !== 'service_role';", repl: 'if (JWT_VALUE_RE.test(value)) return false;' },
  { name: 'the allow check runs at all (else public keys are flagged)', expect: 'a Firebase web key in an unquoted config is public, not a finding', find: 'if (isPublicByDesign(hit[1])) continue;', repl: 'if (false) continue;' },
  { name: 'suppressor excludes changeme (a real weak password, not a placeholder)', expect: 'a password of changeme... is a real weak password, not a placeholder', find: 'placeholder|dummy|replace[-_]?me', repl: 'placeholder|dummy|changeme|replace[-_]?me' },
  { name: 'connection-string password may contain a colon', expect: 'deny: connection string whose PASSWORD contains a colon', find: 'clickhouse):\\/\\/[^\\s@/"\'`]*:[^\\s@/"\'`]+@', repl: 'clickhouse):\\/\\/[^\\s:@/"\'`]*:[^\\s:@/"\'`]+@' },
  { name: 'fake-value suppressor (else a vendored SDK doc comment is flagged)', expect: 'a documentation example value is NOT flagged', find: 'if (d.unlessValue.test(hit[1])) continue;', repl: 'if (false) continue;' },
  { name: 'value-aware rules try EVERY match (else a decoy launders a real credential)', expect: 'a decoy example does NOT launder a real credential in the same file', find: 'while ((hit = every.exec(body)) !== null) {', repl: 'if ((hit = every.exec(body)) !== null) {' },
  { name: 're-derives the restriction while descending (else a NESTED .next/server is unrestricted)', expect: 'a .next/server NESTED under the scanned dir is restricted too', find: 'walk(p, out, seen, only || onlyFor(p));', repl: 'walk(p, out, seen, only);' },
];

// A MUTANT THAT DOES NOT PARSE IS NOT A MUTATION TEST, and nothing downstream can tell the two
// apart: node exits non-zero on a SyntaxError exactly as it does on a caught mutation, so a file
// that never executed a single control would score as CAUGHT and inflate the one number this
// harness exists to produce. Borrowed from check-ship-artifacts.mutants.mjs, which arrived at it
// first and by measurement. It is strictly better than inferring a crash from how many controls
// ran: that is a proxy, this is the actual question, and it names the syntax error in the report
// so the fix is obvious. The control-count check below still runs, for a mutant that PARSES and
// then dies at runtime, which this cannot see.
function parseError(file) {
  try { execFileSync(process.execPath, ['--check', file], { windowsHide: true, stdio: 'pipe' }); return null; }
  catch (e) {
    const line = String((e && e.stderr) || '').split('\n').find((l) => /Error/.test(l));
    return (line || 'parse failed').trim();
  }
}

// Returns the exit code AND the output, plus whether the run produced a verdict at all. A KILLED
// run never answered: `e.status` is null for a signal kill, and treating that as non-zero would
// score "we never found out" as "caught", which is the absence of an answer read as an answer.
function selftestRun(file) {
  try {
    const out = execFileSync(process.execPath, [file, '--selftest'], { encoding: 'utf8', windowsHide: true, timeout: 600000, stdio: 'pipe' });
    return { code: 0, out, noVerdict: null };
  } catch (e) {
    const noVerdict = (e.killed || e.signal) ? (e.signal ? `killed by ${e.signal}` : 'timed out') : null;
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      out: (e.stdout || '') + (e.stderr || ''),
      noVerdict,
    };
  }
}

// A control line is `  ok  <name>  (<measured>)` or `  FAIL <name>  (<measured>)`. Strip only the
// LAST parenthetical: several control NAMES legitimately end in one ("deny: Stripe RESTRICTED key
// (rk_)"), and stripping every parenthetical would merge two names differing only by that suffix
// and report a control proven when its twin was the one reddened. The trailing group is dropped
// because some controls print a MEASURED value in it (elapsed ms), which changes between runs.
const CONTROL_LINE = /^ {2}(ok|FAIL|skip)\s+(.*)$/;
function controlsIn(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = CONTROL_LINE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    map.set(m[2].replace(/\s*\([^()]*\)\s*$/, '').trim(), m[1]);
  }
  return map;
}

function main() {
  // The mutations only prove something if the UNMUTATED gate is green to begin with.
  const base = selftestRun(SRC);
  if (base.code !== 0) {
    console.error(`[mutants] baseline gate selftest is NOT green (exit ${base.code}); fix the gate first.`);
    return 2;
  }
  const baseControls = controlsIn(base.out);
  const skipped = [...baseControls].filter(([, v]) => v === 'skip').map(([k]) => k);

  // Controls are keyed by NAME, so two controls sharing a name collapse into one and the harness
  // then blames the wrong thing (it reported a good mutation as "no control went red"). Worse, a
  // duplicate that FAILS while its twin passes would score a mutation as caught for a control it
  // never broke. Refuse the ambiguity outright rather than reason about which one won.
  const seenNames = new Map();
  for (const line of base.out.split('\n')) {
    const m = CONTROL_LINE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const name = m[2].replace(/\s*\([^()]*\)\s*$/, '').trim();
    seenNames.set(name, (seenNames.get(name) || 0) + 1);
  }
  const dupes = [...seenNames].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) {
    console.error('[mutants] DUPLICATE control name(s); every control must be uniquely named:');
    for (const d of dupes) console.error(`  - ${d}`);
    return 2;
  }
  // Every mutation must NAME the control it proves. Without this a new entry could be added with
  // no `expect` and silently fall back to the weaker "some control went red" check.
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
  const dir = mkdtempSync(join(tmpdir(), 'client-secrets-mut-'));
  // Split, because they mean different things and the gate's own doctrine insists on the
  // distinction: a real escape is a control that asserts nothing (exit 1), while a mutation whose
  // control could not RUN on this host is simply unjudged here (exit 2). Collapsing both into 1
  // would report a defect on any machine that forbids symlink creation.
  const escapes = [];
  const hostLimited = [];
  // Kept apart from escapes on purpose. A malformed mutation and a run that never finished are
  // both "this harness did not ask the question", which is a different fact from "the rule has no
  // control". Both still fail the run, because a mutation that cannot be evaluated is not coverage.
  const malformed = [];
  const unjudged = [];
  const reddened = new Set();
  try {
    for (const m of MUTATIONS) {
      const hits = src.split(m.find).length - 1;
      if (hits !== 1) {
        console.error(`  FAIL     ${m.name}: mutation target found ${hits} time(s), need exactly 1 (harness is stale)`);
        escapes.push(m.name);
        continue;
      }
      const f = join(dir, 'mutant.mjs');
      writeFileSync(f, src.replace(m.find, m.repl));
      // Parse FIRST. A malformed mutation is a bug in this harness, not evidence about the rule,
      // so it is reported as its own outcome rather than as a catch or an escape.
      const bad = parseError(f);
      if (bad) {
        malformed.push(m.name);
        console.error(`  UNPARSEABLE  ${m.name}: the mutated source is not valid JS (${bad}) - rewrite the mutation, the rule is not implicated`);
        continue;
      }
      const { code, out, noVerdict } = selftestRun(f);
      if (noVerdict) {
        unjudged.push(m.name);
        console.error(`  NO VERDICT   ${m.name}: the run never finished (${noVerdict}), so it proves nothing either way`);
        continue;
      }
      const controls = controlsIn(out);
      const reds = [...controls].filter(([, v]) => v === 'FAIL').map(([k]) => k);
      // A non-zero exit is NOT proof a control fired. A mutant that fails to PARSE also exits
      // non-zero, having run NOTHING, and would score as a catch. And SOME control going red is
      // not proof either: the fixtures share payloads, so a rule can score off a neighbour's
      // control while its OWN has been deleted. The named control must be the one that fails.
      const ran = controls.size;
      const crashed = ran < baseControls.size;
      const named = reds.includes(m.expect);
      const caught = code !== 0 && !crashed && named;
      if (!caught) (skipped.includes(m.expect) ? hostLimited : escapes).push(m.name);
      for (const r of reds) reddened.add(r);
      const why = crashed ? `CRASHED, only ${ran}/${baseControls.size} controls ran`
        : reds.length === 0 ? `exit ${code} but NO control went red`
          : named ? `exit ${code}, red: ${m.expect}${reds.length > 1 ? ` +${reds.length - 1} more` : ''}`
            : `exit ${code} but its OWN control stayed GREEN; red instead: ${reds.join(' | ')}`;
      console.log(`  ${caught ? 'ok     ' : 'ESCAPED'}  ${m.name}  (${why})`);
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }

  // REVERSE COVERAGE. Everything above proves mutation -> control. It says nothing about a control
  // that NO mutation can redden, and such a control is never examined at all: it can quietly stop
  // asserting anything and every run stays green. That is not hypothetical, it is how a vacuous
  // control shipped here (an unknown-flag check whose fall-through returned the same exit code it
  // asserted). A control that SKIPPED on this host is counted unproven, never proven, because it
  // did not run. Add a control, add the mutation that reddens it, in the same change.
  // A control that RAN and that no mutation can redden is a real gap. A control that SKIPPED did
  // not run, so it is unknown here, never proven - the same rule the gate applies to a bundle it
  // could not read.
  const gaps = [...baseControls]
    .filter(([name, verdict]) => verdict !== 'skip' && !reddened.has(name))
    .map(([name]) => name);
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
  console.log(`[mutants] all ${MUTATIONS.length} mutations caught, each reddening the control it NAMES.`);
  console.log(`[mutants] all ${baseControls.size} controls proven: every one is reddened by at least one mutation.`);
  return 0;
}

process.exit(main());
