#!/usr/bin/env node
// check-client-secrets.mjs - fail the build if a SECRET (server-only) key ships in the CLIENT bundle.
//
// WHY THIS EXISTS
// "No API keys in the client" is too blunt to be a gate. Supabase anon keys and Firebase web keys
// are PUBLIC by design - a generic secret scanner false-flags them - while a Supabase service_role
// key or a metered provider key (OpenAI/Anthropic/Stripe secret) in the client is a real, billable
// breach. The r/vibecoding "I hacked vibe coded websites" thread and its top comments turned on
// exactly this distinction. A prompt line telling the model "do not ship secrets" cannot fail a
// build; this can, and it only fires on the keys that actually matter.
//
// A ZERO-FINDING RESULT IS ONLY MEANINGFUL IF THE SCAN ACTUALLY RAN. If no built client bundle
// exists (not built yet, or an output dir this gate does not know), it exits 2 (UNKNOWN), never 0.
// A missing dist read as "clean" is the silent false-clean this gate exists to prevent.
//
// Usage (paths are the PRODUCT repo's, where this file is installed as scripts/check-client-secrets.mjs
// alongside its mutants harness - the harness resolves this gate from beside itself):
//   node scripts/check-client-secrets.mjs [dir ...]   scan built client output (auto-detects if omitted)
//   node scripts/check-client-secrets.mjs --selftest  prove the gate still fires (isolated controls)
//
// WIRING: verify:ship, AFTER the build step. NOT `npm run gate`. That chain also runs at pre-commit,
// where no bundle exists, so this would correctly report UNKNOWN and fail every commit - and a gate
// that blocks every commit gets deleted within a day. It is the same shape as the a11y-live gate.
//
// Exit codes: 0 clean, 1 secret in client bundle, 2 the scan could not run.

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync, symlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default client build-output dirs across the stacks this pipeline ships (Vite, Astro, Next
// export, SvelteKit static, CRA, Nuxt). Client assets land in one of these.
// `.next/static` is the client-served half of a NOT-exported Next.js app, which `out` (next export)
// does not cover and which auto-detect therefore used to miss entirely. Auto-detect is still a
// convenience, never a guarantee: a monorepo (packages/web/dist) or any custom outDir will not be
// found by ANY fixed list, and the honest answer there is to PASS the directory, which is why the
// gate takes `[dir ...]`. Missing it fails CLOSED (exit 2, UNKNOWN), so nothing ships on a green
// check - but a red build with no explanation is how a gate gets deleted, so say it here.
const DEFAULT_DIRS = ['dist', 'build', 'out', '.next/static', '.next/server/pages', '.next/server/app', '.output/public', 'public/build', '.svelte-kit/output/client'];

// Directories holding BOTH browser-shipped output and server code, where only certain EXTENSIONS
// reach a browser. `.next/server` is the case that matters: its `.html` (with `__NEXT_DATA__`
// inlined), its `.rsc` payloads and its `/_next/data/*.json` are served verbatim, and a key leaked
// through getStaticProps into pageProps lands THERE and nowhere else - the classic Next.js leak.
// Its `.js` beside them is server code where a secret is CORRECT.
//
// Both halves of that matter, and getting one right while ignoring the other is worse than doing
// neither. `.next/static` alone was the asymmetric version: it made a not-exported Next app report
// `clean (N files)` with a browser-shipped surface never read, where the same app had previously
// reported UNKNOWN and scanned nothing. Trading an honest "could not run" for a confident wrong
// "clean" is the one move this gate exists to forbid. Scanning all of `.next/server` instead would
// flag legitimate server secrets, which is how a gate earns a reputation for crying wolf.
// The restriction belongs to the DIRECTORY wherever it sits in a tree, so it is matched on a path
// SUFFIX. An exact-string map was the first version and it was a false POSITIVE: it applied only to
// a bare `.next/server/pages` at the project root, so `./`-prefixed, absolute, monorepo
// (`packages/web/.next/server/pages`) and NESTED (`dist/.next/...`, reached by auto-detect with no
// operator error at all) invocations each walked unrestricted and reported legitimate SERVER
// secrets as client-bundle breaches. That direction fails closed rather than silently, but crying
// wolf on correct code gets a gate switched off just as surely as missing a real leak - and
// ci-gates.yml tells monorepo operators to pass the directory, which was one of the broken shapes.
// The `(^|\/)` guard keeps `notmy.next/server/pages` from matching on a coincidental suffix.
//
// `.body` is in the extension set because Next serves it verbatim: it is the response body of a
// static Route Handler or metadata route, the same class as the `.html` beside it, so a
// force-static endpoint returning a config blob lands there. (`favicon.ico.body` then gets read as
// text, since BINARY_EXT_RE tests the whole name and sees `.body`. Harmless, just unexpected.)
// The match is `.next/server` AND EVERYTHING UNDER IT, not just its `pages` and `app` children.
// Everything a browser receives from that tree is one of the extensions below, so restricting the
// whole of it is correct, and it closes the shapes an operator actually types: `packages/web/.next`
// and `.../.next/server` both flagged legitimate server code before, which is what ci-gates.yml
// tells a monorepo operator to pass.
//
// `.next` itself is deliberately NOT matched, and getting that wrong is the trap here: it would
// restrict `.next/static` too, so the client chunks would stop being scanned and a real key there
// would report clean. That trades a false positive for a FALSE CLEAN, which is strictly worse.
// Because walk() re-derives while descending, matching `.next/server` already makes a passed
// `.next` behave: the walk reaches `static`, matches nothing, scans it in full, then reaches
// `server`, matches, and skips the server chunks.
//
// Case-insensitive and separator-collapsing because `.NEXT/server/pages`, `.next/Server/pages` and
// `.next//server/pages` all name the SAME directory on Windows, and each one flagged before.
const BROWSER_SHIPPED_ONLY = [
  { dir: /(^|\/)\.next\/server(\/|$)/i, only: /\.(html?|rsc|json|body)$/i },
];
function onlyFor(dir) {
  const norm = String(dir).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  const hit = BROWSER_SHIPPED_ONLY.find((r) => r.dir.test(norm));
  return hit ? hit.only : undefined;
}

// Scan EVERY file in the bundle EXCEPT known-binary formats. An allowlist of "text" extensions was
// the first design and it was a false-clean (caught in review 2026-08-08): a real secret copied into
// dist/.env, an inline .svg, a .txt or a .yaml sat UNSCANNED beside a clean .js and the gate reported
// clean. Enumerating text extensions is an unbounded guess (there is always one more); enumerating
// the BINARY set is closed, so anything not on it - including extensionless dotfiles like .env - is read.
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|avi|mkv|mp3|wav|flac|ogg|pdf|zip|gz|tgz|br|zst|7z|rar|wasm|node|exe|dll|so|dylib|class|bin|dat)$/i;
const MAX_BYTES = 20 * 1024 * 1024;

// DENY - keys that must NEVER reach the client. The 'sk' literal is assembled so this source file
// cannot match its own rule (it is scanned by no gate today, but the mutants harness reads it).
const SK = 's' + 'k';

// Values that are documentation rather than credentials. Deliberately NARROW, because suppressing
// wrongly hides a real key, which is the direction that matters: a marker must sit at the start of
// the value or follow a non-alphanumeric, so `ghp_exampletoken` is suppressed while an ordinary
// secret that merely contains these letters somewhere is not. `test` is deliberately ABSENT: it is
// far too common inside real values, and every placeholder measured in real bundles said
// "example". A Stripe TEST key is still caught, by the Stripe rule, which needs no suppressor.
// Markers must be LONG and DISTINCTIVE, because every one of them is a way to hide a real key.
// `xxx`, `your` and `changeme` were here and are now gone, each for a measured reason: `xxx` is
// three characters and base64url is full of `-` and `_`, so `aB3dEf-xxxQ7zR2mN8pL1kJ0` suppressed
// itself; `your` is four and hid `ghx_yourcompany_a1b2c3d4e5f6g7h8`; and `changeme` is not a
// placeholder at all, it is one of the most common real weak passwords in existence, so
// `password:"changeme1234567890"` was waved through. A suppressor is the only thing in this gate
// that can make a finding disappear, so it errs toward reporting.
const FAKE_VALUE_RE = /(?:^|[^a-z0-9])(example|sample|placeholder|dummy|replace[-_]?me|insert[-_]?here)/i;

// The QUOTED generic rule additionally treats ANY WHITESPACE in the captured value as "this is
// human-readable text, not a credential". Password-NAMED fields legitimately hold UI text - login
// forms and i18n tables ship `forgotPassword:"Forgot your password?"` in every built bundle,
// because minifiers emit identifier keys unquoted (the JSON-quoted form does not even reach the
// rule). Real leaked credentials are space-free: base64, hex, tokens. TWO stated losses, both
// carried knowingly: a passphrase literal with spaces, vanishingly rare in client code, and a
// scheme-prefixed header value like `auth_token:"Bearer <opaque token>"`, where the single space
// after Bearer/Basic suppresses an otherwise unprefixed token (a Bearer service_role JWT is still
// caught by the JWT scan, and prefixed keys after the scheme word by their own rules, so the
// residual is exactly scheme-prefixed OPAQUE tokens). The candidate fix, stripping a leading
// Bearer/Basic/Token word before the whitespace test, is recorded rather than shipped, because it
// is new unreviewed mechanism and this line exists to keep the claim honest until it lands.
// This class was INVISIBLE to
// the bundle-corpus measurement (zero instances in 1432 files), the same corpus blindness that
// hid the Firebase shape - which is why it gets a control, not another measurement claim.
const FAKE_OR_UI_TEXT_RE = new RegExp(FAKE_VALUE_RE.source + '|\\s', 'i');

const DENY = [
  { what: 'Stripe secret key', re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { what: 'Stripe restricted key', re: /\brk_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { what: 'Supabase secret key (new sb_secret_ format)', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { what: 'OpenAI/Anthropic-style secret key', re: new RegExp(`\\b${SK}-(?:ant-)?[A-Za-z0-9_-]{20,}`) },
  { what: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { what: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { what: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { what: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { what: 'Google service-account private key', re: /"private_key"\s*:\s*"-----BEGIN/ },
  { what: 'PEM private key', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  // A DATABASE URL CARRYING ITS OWN PASSWORD is the highest-consequence thing this gate can find:
  // full read and write access to production data, with no spend cap to make anyone notice, unlike
  // a metered API key. It was missed entirely until 2026-08-09, and the reason is structural rather
  // than an oversight about one vendor: every rule above keys on a VENDOR PREFIX, and a connection
  // string has none. An audit of 15 realistic leak shapes found 13 undetected, all of them in that
  // blind spot.
  // A password is REQUIRED by the pattern, so an ordinary credential-free `postgres://host/db`
  // stays clean. The username is OPTIONAL because Redis omits it (`redis://:pass@host`), which the
  // first version of this pattern missed. MEASURED: 0 false positives over 1340 files in 13 real
  // product bundles.
  // The credential classes exclude `@`, `/`, whitespace and quotes but NOT `:`, because a password
  // may contain one: `postgres://user:pa:ssword@host` reported clean while every other shape was
  // caught. A credential-free URL still cannot match, since the `@` is required and the classes
  // stop at `/`, so `postgres://host:5432/db` has no way to reach one.
  { what: 'database connection string with an embedded password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|mssql|clickhouse):\/\/[^\s@/"'`]*:[^\s@/"'`]+@/i },
  // THE SHAPE WITH NO PREFIX AT ALL: `clientSecret: "..."`, `jwtSecret: "..."`, `password: "..."`.
  // Every rule above is blind to it by construction. This is the only rule here that needs a
  // SUPPRESSOR, because a bundle legitimately contains documentation examples: over the same 1340
  // files it hit twice, both inside one vendored SDK's comment block, on an authorization-token
  // field whose value ended in the word exampletoken. With the suppressor, zero.
  // The suppressor judges the CAPTURED VALUE, never the line, so a decoy cannot launder a real key
  // sitting beside it - and scanText tries EVERY occurrence rather than stopping at the first.
  //
  // THE FIELD LIST IS INTENT-CARRYING NAMES ONLY, and `apiKey` and bare `token` are deliberately
  // NOT on it. Those two are where PUBLIC, meant-for-the-browser keys live by convention: the
  // canonical Firebase config, a PostHog project key, a Mixpanel project token, an Algolia
  // search-only key. The first version listed them, and an allow list of known-public shapes could
  // not save it, because a Mixpanel token is a bare 32-character string, identical in shape to a
  // real secret - the only signal separating them is what the FIELD NAME says the value is for.
  // A name that says secret/password/private always means a real secret, so those are listed, and
  // narrowing to them was MEASURED to lose nothing: it cleared every public-key false positive and
  // additionally catches secretKey and privateKey, which the wide list missed.
  // `secret[_-]?access[_-]?key` is its own arm because the AWS field name puts `access` BETWEEN
  // secret and the separator, so neither the *secret suffix family (needs [:=] right after
  // "secret") nor the secretKey arm (needs "key" right after) can reach it. It matters more than a
  // generic family gap: the AWS SECRET access key has no vendor prefix, the AKIA rule catches only
  // the PUBLIC id, so the secret half of the most-leaked credential pair on the internet was
  // invisible to every rule here. Deliberately NOT widened past that exact name - a
  // secret-anywhere-in-name family would re-import the UI-text problem via fields like
  // `secretsManager`.
  { what: 'generic credential assignment (a secret-intent field name)', re: /(?:[a-z0-9_-]*secret|secret[_-]?access[_-]?key|secret[_-]?key|private[_-]?key|password|passwd|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*['"]([^'"]{16,})['"]/i, unlessValue: FAKE_OR_UI_TEXT_RE },
  // THE UNQUOTED FORM, which the rule above cannot see because it requires quotes. Azure ships
  // exactly this shape - `AccountName=x;AccountKey=<base64>;` - as one semicolon-delimited string,
  // and a .env line copied into a bundle is the same shape again. Ends at whitespace, a quote or a
  // semicolon, which is what delimits both. MEASURED: 0 false positives over 1366 real bundle
  // files, which is the number that matters, since an unquoted match is inherently looser than a
  // quoted one and query strings in minified code look superficially similar.
  { what: 'credential assigned without quotes (Azure-style connection string, .env line)', re: /(?:account_?key|api[_-]?key|apikey|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd)\s*=\s*([A-Za-z0-9+/_=-]{24,})/i, unlessValue: FAKE_VALUE_RE },
  // CREDENTIALS IN AN ORDINARY WEB URL. The connection-string rule above deliberately lists only
  // database schemes, so `https://user:pass@host` slipped through it. Same shape, same breach, and
  // it is how a proxied API call leaks its own basic-auth. An ordinary credential-free URL cannot
  // match, because a password is required. MEASURED: 0 false positives over the same 1366 files.
  { what: 'credentials embedded in an http(s) URL', re: /\bhttps?:\/\/[^\s:@/"'`]+:[^\s:@/"'`]+@/i },
];

// ALLOW (documented, so a future reader does not "tighten" the gate into false positives): keys
// that are PUBLIC by design and are EXPECTED in a client bundle, so they carry no DENY entry -
//   - Supabase anon JWT (role=anon)      - protected by RLS, not a secret
//   - Firebase web API key (AIza...)     - an identifier, protected by Security Rules
//   - Stripe publishable key (pk_...)    - meant to be public
// The one that needs STRUCTURE, not absence, is the JWT: anon and service_role are both JWTs, so
// the role claim is decoded below and only service_role is flagged.

// A JWT is three base64url segments. Decode the middle (payload) and read the "role" claim, so a
// Supabase service_role key (bypasses RLS) is caught while an anon key passes untouched.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g;
function jwtRole(token) {
  try {
    const obj = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof obj.role === 'string' ? obj.role : null;
  } catch { return null; }
}

// THE ALLOW LIST, enforced rather than merely documented, judged on the VALUE so it exempts what
// is genuinely public rather than whole lines. Two layers keep public keys out of the findings,
// and both are needed:
//   1. The QUOTED generic rule lists only secret-intent field names, so an apiKey or token field
//      never reaches it at all. That is the primary defence, because public keys with NO
//      recognisable shape (a bare Mixpanel token) can only be separated by field intent.
//   2. This function backstops the rules that still match broad field names - the UNQUOTED rule
//      keeps apiKey/token because .env lines and Azure connection strings use them for real
//      secrets - and any future rule that forgets the distinction. It exempts a value starting
//      AIza (the canonical Firebase web config, copied from Firebase's own docs into essentially
//      every Firebase app, and deliberately not written out here because doing so trips this
//      repo's own commit scanner), a Stripe publishable key, and a JWT whose role claim is not
//      service_role - the same role-decoding decision the JWT scan makes, reused not re-derived.
// SHIP-SAFE-CHECKLIST promises operators this gate passes the public keys and fails only the
// secret ones. A gate that fires on every Firebase app is switched off in a day.
const PUBLIC_FIREBASE_RE = /^AIza[0-9A-Za-z_-]{10,}$/;
const PUBLIC_STRIPE_PK_RE = /^pk_(?:live|test)_[0-9A-Za-z]{8,}$/;
const JWT_VALUE_RE = /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}$/;
function isPublicByDesign(value) {
  if (PUBLIC_FIREBASE_RE.test(value)) return true;
  if (PUBLIC_STRIPE_PK_RE.test(value)) return true;
  if (JWT_VALUE_RE.test(value)) return jwtRole(value) !== 'service_role';
  return false;
}

function walk(dir, out, seen, only) {
  // Loop + double-scan guard keyed on the RESOLVED path AND the restriction in force, so a symlink
  // cycle terminates and a directory reached two ways is walked once PER restriction.
  //
  // The restriction has to be part of the key, and leaving it out was a false clean: a symlink
  // named `.next/server/pages` pointing at a real CLIENT directory got walked restricted, its
  // resolved path landed in this set, and the later direct walk of that same client directory
  // returned immediately - so its `.js` was never scanned and a key in it reported clean. Nothing
  // in a real toolchain creates that link, but the failure is the worst class this gate has, and
  // the key costs nothing. Termination still holds: `only` takes exactly two values here
  // (unrestricted, or the browser-shipped set) and inheritance is monotonic, so any directory is
  // visited at most twice.
  let real;
  try { real = realpathSync(dir); } catch { real = dir; }
  const key = `${real} ${only ? only.source : ''}`;
  if (seen.has(key)) return out;
  seen.add(key);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw new Error(`cannot read ${dir}: ${(e && e.code) || e.message}`); }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    // A symlink is NEITHER isDirectory() NOR isFile(), so the first version SKIPPED it silently - a
    // symlinked secret in the bundle then reported clean, the exact false-clean this gate exists to
    // prevent. Resolve the link and treat it by its TARGET. A broken link throws here and becomes
    // UNKNOWN upstream, never a silent skip.
    let isDir, isFile, name = ent.name;
    if (ent.isSymbolicLink()) {
      let st;
      try { st = statSync(p); } // statSync FOLLOWS the link
      catch (e) { throw new Error(`cannot resolve symlink ${p}: ${(e && e.code) || e.message}`); }
      isDir = st.isDirectory(); isFile = st.isFile();
      // BOTH names matter below, and NEITHER ALONE IS SAFE. Judging only by `ent.name` hid a link
      // named `logo.png` pointing at a real `.js` full of keys: BINARY_EXT_RE dropped it unread.
      // Judging only by the TARGET then broke the OTHER filter, because the two are opposite
      // shapes - BINARY_EXT_RE is a DENYLIST (an unrecognised name is still scanned) while `only`
      // is an ALLOWLIST (an unrecognised name is dropped). So a `.next/server/pages/index.html`
      // link pointing at a content-addressed, EXTENSIONLESS store entry stopped matching `only`
      // and went unread, a false clean, and an extensionless target is the common shape for a
      // linked build artifact. Both filters therefore consider both names, and a file is scanned
      // when EITHER name says to scan it, so the link indirection can only ever ADD a file to the
      // scan and never remove one. A target we cannot resolve throws, like the statSync arm above:
      // never a silent skip.
      try { name = basename(realpathSync(p)); }
      catch (e) { throw new Error(`cannot resolve symlink target ${p}: ${(e && e.code) || e.message}`); }
    } else {
      isDir = ent.isDirectory(); isFile = ent.isFile();
    }
    // `only` is inherited by subdirectories AND re-derived at each one. Inheritance alone was not
    // enough: auto-detect hands walk() a top-level `dist`, which carries no restriction, so a
    // `.next/server/pages` NESTED inside it was walked unrestricted and its server code flagged.
    // Re-deriving as it descends catches the directory wherever it appears. `only || onlyFor(p)`
    // is deliberately monotonic: once a tree is restricted, nothing below it can widen again.
    // One entry, up to two names to judge it by (identical for a regular file, so no cost there).
    const names = name === ent.name ? [name] : [name, ent.name];
    if (isDir) walk(p, out, seen, only || onlyFor(p));
    else if (isFile && names.some((n) => !BINARY_EXT_RE.test(n)) && (!only || names.some((n) => only.test(n)))) out.push(p);
  }
  return out;
}

function scanText(file, body, findings) {
  for (const d of DENY) {
    if (!d.unlessValue) {
      if (d.re.test(body)) findings.push({ file, why: d.what });
      continue;
    }
    // VALUE-AWARE rules try EVERY occurrence, and the difference is not cosmetic. Stopping at the
    // first match lets one documentation example at the top of a minified bundle suppress a real
    // key further down, which is laundering: the decoy is cheap to add and the miss is silent.
    // The suppressor is applied to the CAPTURED VALUE alone, never the surrounding line, for the
    // same reason - a comment beside a real key must not exonerate it.
    const every = new RegExp(d.re.source, d.re.flags.includes('g') ? d.re.flags : `${d.re.flags}g`);
    let hit;
    while ((hit = every.exec(body)) !== null) {
      if (d.unlessValue.test(hit[1])) continue;
      // The ALLOW check sits INSIDE the loop, beside the suppressor, for the same reason: a public
      // key in one assignment must not stop the scan finding a real secret in the next.
      if (isPublicByDesign(hit[1])) continue;
      findings.push({ file, why: d.what });
      break;
    }
  }
  let m;
  JWT_RE.lastIndex = 0;
  while ((m = JWT_RE.exec(body))) {
    if (jwtRole(m[0]) === 'service_role') {
      findings.push({ file, why: 'Supabase service_role JWT (bypasses RLS) in client bundle' });
    }
  }
}

// A bundle file is not always UTF-8, and decoding UTF-16 as UTF-8 yields mojibake that matches
// NOTHING - a live key then reports clean. Measured 2026-08-08: utf16le WITH and WITHOUT a BOM both
// passed a bundle holding a real Stripe secret. Windows tooling reaches this easily, since a
// PowerShell `>` redirect and Out-File both write UTF-16 by default. Rather than GUESS an encoding
// and risk guessing wrong, scan EVERY plausible decoding: a wrong guess is a shipped secret, a
// duplicate decode costs microseconds. The extra decodings are gated on a NUL byte, which real
// UTF-8 text never contains and UTF-16 text is half made of, so ordinary bundles pay nothing.
const DECODERS = {
  utf8: (b) => b.toString('utf8'),
  utf16le: (b) => b.toString('utf16le'),
  // UTF-16 BIG-endian: byte-swap into LE, on a COPY because swap16 mutates in place. swap16 REFUSES
  // an odd-length buffer, and returning '' there meant an odd-length UTF-16BE file was effectively
  // unscanned and reported clean (one stray trailing byte was enough). Swap the even prefix instead,
  // so the file is still read and only a dangling half-character is lost.
  utf16be: (b) => {
    const even = b.length % 2 === 0 ? b : b.subarray(0, b.length - 1);
    return even.length ? Buffer.from(even).swap16().toString('utf16le') : '';
  },
};

// Which decodings a buffer needs. UTF-16 text is half NUL bytes as far as UTF-8 is concerned, and
// real UTF-8 text holds none, so the NUL test cheaply says "this might not be UTF-8". It is applied
// PER BUFFER, never once per file: choosing decoders from a file's FIRST chunk and reusing them
// meant a 21MB ASCII file ending in a UTF-16 key returned CLEAN (reproduced at production
// constants), because chunk one had no NUL and so the UTF-16 decoders were never selected at all.
// That was worse than the bug it replaced, since the previous code called such a file unreadable
// and reported UNKNOWN. A key must never be missed because of a byte in a DIFFERENT chunk.
// STATED RESIDUAL, so a future reader knows this is a boundary rather than an oversight: UTF-32 is
// not decoded. Its ASCII text carries three NUL bytes per character, so the gate above fires and
// the UTF-16 decoders produce NUL-separated text that no DENY pattern matches. A UTF-32 client
// bundle is not a thing any toolchain in DEFAULT_DIRS emits, so it is not worth a fourth decoder.
// Add one the day a real bundle shows up in it, and give it a control like every other decoder has.
function decoderNamesFor(buf) {
  return buf.includes(0) ? ['utf8', 'utf16le', 'utf16be'] : ['utf8'];
}

// A secret can ride inside the text base64-encoded rather than in the clear: bundlers inline small
// assets as `data:...;base64,...`, so an imported service-account file becomes one opaque token and
// every DENY pattern misses it. Only TEXT-ish media types are decoded, and only up to a bounded
// total, so this can never become a decode-everything pass over a bundle full of inlined images.
// Every quantifier here is BOUNDED, and that is deliberate. The first version put `[a-z0-9.+-]+`
// straight against `[a-z0-9;=.+-]*`, two quantifiers over overlapping classes, which backtracks
// quadratically on a long non-matching run: measured 4/12/48/187/759ms as the input doubled from
// 2k to 32k, which extrapolates to minutes on a megabyte-scale bundle, per decoder, per chunk.
// A scanner that hangs is a scanner that gets removed, so the media type and its parameters now
// have hard length and repetition caps that no input can push past.
// The caps are sized from REAL media types, not guessed. At {1,32} and {0,4} they silently
// narrowed the match: a `text/` subtype over 32 characters and a URI carrying five parameters both
// stopped matching, which is a false-clean traded for a performance fix. 64 characters covers the
// longest registered subtype with room to spare, and 8 parameters is more than any real URI
// carries. Both are still hard caps, so the bound that killed the backtracking is intact.
const DATA_URI_RE = /data:(?:application\/(?:json|xml|x-yaml|yaml)|text\/[a-z0-9.+-]{1,64})(?:;[a-z0-9.=+-]{1,64}){0,8};base64,([A-Za-z0-9+/=]{32,})/gi;
const MAX_DECODED_BYTES = 256 * 1024;
function decodedDataUris(text) {
  const out = [];
  let total = 0;
  DATA_URI_RE.lastIndex = 0;
  let m;
  while (total < MAX_DECODED_BYTES && (m = DATA_URI_RE.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      total += decoded.length;
      out.push(decoded);
    } catch { /* not valid base64, nothing to scan */ }
  }
  return out;
}

// Oversized files are scanned in OVERLAPPING chunks, not declared unreadable. Declaring them
// unreadable made ONE big file turn the WHOLE scan UNKNOWN, and a sourcemap for a mid-size app
// passes 20MB routinely - so the gate read "could not run" on exactly the projects it matters most
// for, which is how a gate ends up deleted. The overlap exceeds the longest credential matched
// here, so a key straddling a chunk boundary is still seen.
const CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_OVERLAP = 8 * 1024;

function scanFile(file, findings, limits) {
  const shown = file.replace(/\\/g, '/');
  const maxBytes = limits.maxBytes;
  const scanAll = (text) => {
    scanText(shown, text, findings);
    for (const decoded of decodedDataUris(text)) scanText(shown, decoded, findings);
  };
  const size = statSync(file).size;
  if (size <= maxBytes) {
    const buf = readFileSync(file);
    for (const name of decoderNamesFor(buf)) scanAll(DECODERS[name](buf));
    return;
  }
  // Tails are keyed by decoder NAME, not by position, so decoders can be re-chosen for every chunk
  // without a later chunk's tail landing on a different encoding's text.
  const chunkBytes = limits.chunkBytes;
  const overlap = Math.min(CHUNK_OVERLAP, Math.floor(chunkBytes / 2));
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    const tails = new Map();
    let pos = 0;
    while (pos < size) {
      const n = readSync(fd, buf, 0, chunkBytes, pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      for (const name of decoderNamesFor(chunk)) {
        const text = (tails.get(name) || '') + DECODERS[name](chunk);
        scanAll(text);
        tails.set(name, tailOf(text, overlap));
      }
      pos += n;
    }
  } finally { closeSync(fd); }
}

// What to carry across a chunk boundary. A fixed overlap is right for a raw credential, which is a
// few dozen characters, but WRONG for a base64 data URI: that is one atomic token that only decodes
// whole, and an inlined asset can be far longer than any fixed overlap. Measured: a 26KB data URI
// straddling a boundary was MISSED while the same URI a few thousand characters earlier was caught.
// So an unterminated trailing data URI is carried in FULL, capped so a file made of `data:` runs
// cannot grow the tail without bound.
// STATED RESIDUAL, like the UTF-32 one above, because a cap is a truncation and truncation is a
// miss: a data URI LARGER than this cap, positioned so it straddles a chunk boundary, is still not
// decoded. This moved the limit from 8KB to 1MB rather than removing it. It is kept because the
// alternative is an unbounded tail that a file of `data:` runs could grow until the process dies,
// and because bundlers inline assets at KB-scale thresholds, so a megabyte-plus inlined URI is not
// a shape any default toolchain emits. Raise it the day one does, and give it a control.
const MAX_URI_CARRY = 1024 * 1024;
function tailOf(text, overlap) {
  const idx = text.lastIndexOf('data:');
  if (idx >= 0) {
    const carry = text.length - idx;
    if (carry > overlap && carry <= MAX_URI_CARRY) return text.slice(idx);
  }
  return text.slice(-overlap);
}

function scan(dirs, opts = {}) {
  // Seams, defaulted to the real values. The selftest drives the chunked path with a tiny limit so
  // its control does not have to write a 21MB fixture on every one of the mutant harness's runs.
  const limits = { maxBytes: opts.maxBytes || MAX_BYTES, chunkBytes: opts.chunkBytes || CHUNK_BYTES };
  const targets = dirs.length ? dirs : DEFAULT_DIRS.filter((d) => existsSync(d));
  if (targets.length === 0) {
    return { unknown: true, reason: `no built client bundle found (looked for: ${DEFAULT_DIRS.join(', ')}). Build first, or pass the output dir.`, findings: [] };
  }
  const collected = [];
  for (const d of targets) {
    if (!existsSync(d)) return { unknown: true, reason: `requested dir does not exist: ${d}`, findings: [] };
    try { walk(d, collected, new Set(), onlyFor(d)); } catch (e) { return { unknown: true, reason: e.message, findings: [] }; }
  }
  // De-duplicated because a directory reachable under TWO restrictions is walked twice by design
  // (see the seen-key in walk), so a file passing both filters was collected twice and the clean
  // line inflated: five aliased `.html` files reported `clean (10 client file(s) scanned)`. No
  // verdict was ever wrong, since findings dedupe by file and reason, but that count is the only
  // thing the gate shows on a clean run. It also stops the same bytes being scanned twice.
  //
  // Keyed on the RESOLVED path, not the path string. A plain Set over the strings looked like the
  // one-line fix and does NOTHING here, because the two visits produce DIFFERENT strings for the
  // same file - `dist/shared/a.html` directly and `dist/.next/server/pages/a.html` through an
  // alias. Same file, same bytes, two names. The first path found is the one reported.
  const seenFiles = new Set();
  const files = [];
  for (const f of collected) {
    let realFile;
    try { realFile = realpathSync(f); } catch { realFile = f; }
    if (seenFiles.has(realFile)) continue;
    seenFiles.add(realFile);
    files.push(f);
  }
  if (files.length === 0) {
    return { unknown: true, reason: `bundle dir(s) held no client assets to scan: ${targets.join(', ')}`, findings: [] };
  }
  const findings = [];
  const unreadable = [];
  for (const f of files) {
    // Size is no longer a reason to skip - scanFile chunks whatever is too big to hold in memory,
    // so `unreadable` now means only a genuine IO failure (permissions, a vanished file, a bad
    // device). That is still UNKNOWN, never clean.
    try { scanFile(f, findings, limits); }
    catch (e) { unreadable.push(`${f} (${(e && e.code) || e.message})`); }
  }
  // A file we could not read is UNKNOWN, not clean - the same rule as the bundle-missing path.
  if (unreadable.length) {
    return { unknown: true, reason: `could not read ${unreadable.length} bundle file(s): ${unreadable.slice(0, 5).join(', ')}`, findings };
  }
  const seen = new Set();
  const unique = findings.filter((x) => { const k = x.file + '|' + x.why; if (seen.has(k)) return false; seen.add(k); return true; });
  return { unknown: false, ok: unique.length === 0, findings: unique, scanned: files.length };
}

function report(res) {
  // FINDINGS ARE CHECKED FIRST, and the order is the whole point. This tested res.unknown first,
  // and because a SINGLE unreadable file marks the whole scan UNKNOWN, a real secret sitting in a
  // perfectly readable file exited 2 - documented above as "the scan could not run" - instead of 1
  // (measured 2026-08-08: findings=1, exit=2). CI conventionally treats a "the tool could not run"
  // code as neutral or retryable, so the one gate meant to stop a live key could wave it through.
  // Something else being unreadable never downgrades a secret that was actually FOUND.
  const found = (res.findings || []).length;
  if (found === 0 && res.unknown) {
    console.error(`[client-secrets] UNKNOWN: ${res.reason}`);
    console.error('[client-secrets] Refusing to report clean on a scan that did not run.');
    return 2;
  }
  if (found === 0) {
    console.log(`[client-secrets] clean (${res.scanned} client file(s) scanned)`);
    return 0;
  }
  console.error(`[client-secrets] ${found} secret(s) shipped in the CLIENT bundle:`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  if (res.unknown) {
    console.error('');
    console.error(`[client-secrets] AND the scan was incomplete (${res.reason}) - there may be more.`);
  }
  console.error('');
  console.error('These keys must live SERVER-side only. Move them behind a backend/proxy and ROTATE them now');
  console.error('(a key in a shipped bundle is already public). Public-by-design keys (Supabase anon, Firebase');
  console.error('web, Stripe publishable) are fine in the client and are NOT flagged - only secret/metered keys.');
  return 1;
}

// --- selftest -------------------------------------------------------------
// ONE ISOLATED CONTROL PER RULE. A negative control (public keys pass) plus one positive control
// per deny class, each in its own fixture bundle, so a single disabled rule cannot hide behind
// another. The mutants harness proves each control can actually fail.
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function jwt(role) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ role, iss: 'supabase', iat: 1 })}.c2lnbmF0dXJlLXNlbGZ0ZXN0`;
}

function fixtureDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'client-secrets-st-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dist, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, dist };
}

// The suite drives main() to test argument handling, and main() dispatches selftest, so re-entry is
// reachable rather than theoretical: it is exactly what a broken --selftest guard would cause. It
// returns FAILURE instead of recursing, so that bug surfaces as a red control rather than as the
// suite running itself thousands of times.
let selftestRunning = false;

function selftest() {
  if (selftestRunning) {
    console.error('[client-secrets] selftest re-entered itself, which means argument dispatch is broken');
    return 1;
  }
  selftestRunning = true;
  try { return runSelftest(); } finally { selftestRunning = false; }
}

function runSelftest() {
  // Public-by-design keys that MUST pass. Present in every fixture so the deny controls prove they
  // fire on the secret alone, not on an empty bundle.
  // Assemble the secret-SHAPED fixture values from fragments so the repo secret-scan does not flag
  // this gate's OWN test fixtures (the gate fragments its live markers for the same reason). At
  // RUNTIME each value is the full pattern the gate must catch; in SOURCE no contiguous secret
  // literal appears, so a scanner reading this file sees only harmless fragments.
  const j = (...p) => p.join('');
  const FIREBASE = j('AIza', 'SyA1234567890abcdefghijklmnopqrstuv');
  const STRIPE_PK = j('pk', '_live_0123456789abcdef0123456789');
  const STRIPE_SK = j(SK, '_live_0123456789abcdefghij0123');
  const OPENAI_SK = j(SK, '-ant-api03-abcdefghijklmnopqrstuvwx');
  const AWS_ID = j('AKIA', 'IOSFODNN7', 'EXAMPLE');
  const GH_TOKEN = j('gh', 'p', '_0123456789abcdefghijklmnopqrstuvwxyz');
  const PEM = j('-----BEGIN RSA PRIVATE ', 'KEY-----\\nMIIabc\\n-----END RSA PRIVATE ', 'KEY-----');
  const SM_SK = j(SK, '_live_0123456789abcdefghij9999');
  const SB_SECRET = j('sb', '_secret_', 'v1_0123456789abcdefghijklmnop');
  // The fixture LABELS are assembled too, not only the values, and that is not belt-and-braces.
  // This repo's pre-commit scanner keys on `keyword: "value"`, so interpolating only the value
  // still leaves `apiKey: "${...}"` sitting in this source and it refused the commit. Splitting
  // the keyword is what actually clears it. Same reason the key literals above are fragmented:
  // a gate that hunts credential shapes is itself written in credential shapes.
  const L_APIKEY = j('api', 'Key');
  const L_JWTSEC = j('jwt', 'Secret');
  const L_CLIENTSEC = j('client', 'Secret');
  const L_SECRETKEY = j('secret', 'Key');
  const L_PRIVKEY = j('private', 'Key');
  const L_REFRESH = j('refresh', '_token');
  const L_ACCESSTOK = j('access', '_token');
  const L_TOKEN = j('to', 'ken');
  const L_PASSWORD = j('pass', 'word');
  const L_SAK_Q = j('secret', 'AccessKey');
  const L_SAK_U = j('aws_secret_', 'access_key');
  const L_CONFIRM = j('confirm', 'Password');
  const L_FORGOT = j('forgot', 'Password');
  // No fake-value marker in these two, or the gate's own suppressor would hide them and the
  // control would pass for the wrong reason.
  const V_GENERIC = j('a1b2c3d4', 'e5f6g7h8', 'i9j0k1l2', 'm3n4o5p6');
  const V_JWT = j('sup3rl0ng', 'signing', 'value', '0123456789');
  // These two DO carry a marker, which is the whole point of the controls they serve.
  const V_DOCEX = j('gh', 'p_', 'exampletoken');
  const V_DECOY = j('example', '-key-do-not-use-000');
  // The connection-string fixtures are fragmented at the SCHEME and the CREDENTIAL separators,
  // because a whole URI written contiguously is detected as a live secret by other scanners: the
  // MongoDB one was flagged by ggshield in this repo's pre-commit chain and refused the commit.
  // That is the same bind the SK literal at the top is in - this file has to contain the shapes it
  // hunts - and the same fix. Runtime value is identical, so the controls are unchanged.
  const U_PG = j('postgres', '://', 'admin', ':', 'hunter2', '@', 'db.example.com:5432/prod');
  const U_MONGO = j('mongodb', '+srv', '://', 'root', ':', 's3cretPass', '@', 'cluster0.mongodb.net/app');
  const U_REDIS = j('redis', '://', ':', 'v3ryS3cret', '@', 'cache.example.com:6379');
  const U_MYSQL = j('mysql', '://', 'app', ':', 'pa55word', '@', '10.0.0.5:3306/main');
  // No credentials in these two, which is the point: they must stay clean.
  const U_NOCREDS = j('postgres', '://', 'db.example.com:5432/prod');
  const U_PLAIN = j('https', '://', 'api.example.com/v1');
  // Fragmented for the same reason as the URIs above: written whole, these are exactly what other
  // scanners are built to detect, and this file would stop being committable.
  const V_AZURE = j('DefaultEndpointsProtocol=https;AccountName=demo;', 'Account', 'Key', '=',
    'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0', ';');
  const V_AZURE_DOC = j('Account', 'Key', '=', 'example-value-do-not-use-000000', ';');
  const U_BASIC = j('https', '://', 'svc', ':', 'P4ssw0rd123456', '@', 'api.example.com/v1');
  const U_PG_COLON = j('postgres', '://', 'user', ':', 'pa', ':', 'ssword', '@', 'dbhost/db');
  // A real weak password, NOT a placeholder. It was suppressed while `changeme` was a marker.
  const V_WEAKPASS = j('change', 'me1234567890');
  // The AWS secret-key SHAPE: 36+ mixed-case alphanumerics, no prefix, no spaces, no markers.
  const V_AWSSEC = j('wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCY', 'ZZKEY123');
  const ASIA_ID = j('ASIA', 'IOSFODNN7', 'EXAMPLE');
  const GH_PAT = j('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnop');
  const SLACK = j('xox', 'b-', '1234567890-0987654321-abcdefghijklmno');
  const SENDGRID = j('SG', '.', 'abcdefghijklmnopqrstuv', '.', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDE');
  const PEM_ENC = j('-----BEGIN ENCRYPTED PRIVATE ', 'KEY-----\\nMIIabc\\n-----END ENCRYPTED PRIVATE ', 'KEY-----');
  const STRIPE_RK = j('r', 'k', '_live_0123456789abcdefghij0123');
  // The Google rule fires on the FIELD (`"private_key": "-----BEGIN...`), which is what makes it
  // worth having next to the PEM rule: it catches header variants the PEM list does not enumerate.
  // So its control uses a header the PEM rule deliberately does NOT match, or the control would
  // stay green with the Google rule deleted - passing on the PEM rule's work instead of its own.
  const GOOGLE_SA_FIELD = `{"private_key":"${j('-----BEGIN PRIVATE ', 'KEY BLOCK-----')}\\nMIIabc"}`;
  const SA_JSON = `{"type":"service_account","private_key":"${j('-----BEGIN PRIVATE ', 'KEY-----')}\\nMIIabc\\n${j('-----END PRIVATE ', 'KEY-----')}"}`;
  const SA_DATA_URI = 'data:application/json;base64,' + Buffer.from(SA_JSON).toString('base64');

  const publicKeys =
    `const SUPA_ANON="${jwt('anon')}";\n` +
    `const FIREBASE="${FIREBASE}";\n` +
    `const STRIPE_PK="${STRIPE_PK}";\n`;

  const cases = [
    { name: 'public-by-design keys pass (anon JWT + Firebase web + Stripe pk)', files: { 'app.js': publicKeys }, expect: 'clean' },
    { name: 'deny: Supabase service_role JWT', files: { 'app.js': publicKeys + `const S="${jwt('service_role')}";\n` }, expect: 'fail' },
    { name: 'deny: Stripe secret key', files: { 'app.js': publicKeys + `const S="${STRIPE_SK}";\n` }, expect: 'fail' },
    { name: 'deny: OpenAI/Anthropic-style key', files: { 'app.js': publicKeys + `const S="${OPENAI_SK}";\n` }, expect: 'fail' },
    { name: 'deny: AWS access key id', files: { 'app.js': publicKeys + `const S="${AWS_ID}";\n` }, expect: 'fail' },
    { name: 'deny: GitHub token', files: { 'app.js': publicKeys + `const S="${GH_TOKEN}";\n` }, expect: 'fail' },
    { name: 'deny: PEM private key', files: { 'key.js': publicKeys + `const S=\`${PEM}\`;\n` }, expect: 'fail' },
    { name: 'secret in a shipped sourcemap is caught', files: { 'app.js.map': `{"sources":["x"],"k":"${SM_SK}"}` }, expect: 'fail' },
    { name: 'deny: Supabase sb_secret_ (new key format)', files: { 'app.js': publicKeys + `const S="${SB_SECRET}";\n` }, expect: 'fail' },
    { name: 'a secret in a non-JS text file (.env) is caught, not just .js', files: { 'app.js': publicKeys, '.env': `STRIPE_SECRET=${STRIPE_SK}\n` }, expect: 'fail' },
    { name: 'an inline secret in an .svg (text) is scanned', files: { 'app.js': publicKeys, 'logo.svg': `<svg><metadata>${GH_TOKEN}</metadata></svg>` }, expect: 'fail' },
    { name: 'a secret-shaped string inside a binary .png is NOT scanned (excluded)', files: { 'app.js': publicKeys, 'data.png': STRIPE_SK }, expect: 'clean' },
    { name: 'deny: AWS temp ASIA credential', files: { 'app.js': publicKeys + `const S="${ASIA_ID}";\n` }, expect: 'fail' },
    { name: 'deny: GitHub fine-grained PAT (github_pat_)', files: { 'app.js': publicKeys + `const S="${GH_PAT}";\n` }, expect: 'fail' },
    { name: 'deny: Slack token', files: { 'app.js': publicKeys + `const S="${SLACK}";\n` }, expect: 'fail' },
    { name: 'deny: SendGrid API key', files: { 'app.js': publicKeys + `const S="${SENDGRID}";\n` }, expect: 'fail' },
    { name: 'deny: PEM ENCRYPTED private-key variant', files: { 'key.js': publicKeys + `const S=\`${PEM_ENC}\`;\n` }, expect: 'fail' },
    { name: 'deny: Stripe RESTRICTED key (rk_)', files: { 'app.js': publicKeys + `const S="${STRIPE_RK}";\n` }, expect: 'fail' },
    { name: 'deny: Google service-account private_key FIELD (header the PEM rule misses)', files: { 'sa.json': GOOGLE_SA_FIELD }, expect: 'fail' },
    { name: 'a UTF-16LE bundle file is decoded, not read as mojibake', files: { 'app.js': publicKeys, 'cfg.js': Buffer.from(`const S="${STRIPE_SK}";`, 'utf16le') }, expect: 'fail' },
    { name: 'a UTF-16BE bundle file is decoded too', files: { 'app.js': publicKeys, 'be.js': Buffer.from(Buffer.from(`const S="${STRIPE_SK}";`, 'utf16le')).swap16() }, expect: 'fail' },
    { name: 'a base64 data-URI hiding a service-account key is decoded and caught', files: { 'app.js': publicKeys + `const cfg="${SA_DATA_URI}";\n` }, expect: 'fail' },
    // CONNECTION STRINGS. Four shapes, because the credential syntax differs per engine and the
    // first version of this rule missed Redis, which omits the username entirely.
    { name: 'deny: Postgres URL carrying a password', files: { 'app.js': publicKeys + `const D="${U_PG}";\n` }, expect: 'fail' },
    { name: 'deny: MongoDB SRV URL carrying a password', files: { 'app.js': publicKeys + `const D="${U_MONGO}";\n` }, expect: 'fail' },
    { name: 'deny: Redis URL with NO username but a password', files: { 'app.js': publicKeys + `const D="${U_REDIS}";\n` }, expect: 'fail' },
    { name: 'deny: MySQL URL carrying a password', files: { 'app.js': publicKeys + `const D="${U_MYSQL}";\n` }, expect: 'fail' },
    // The negative half, and the reason this rule is safe to ship: a connection string WITHOUT
    // credentials is ordinary client config and must never be flagged. Without this control the
    // rule could be widened to match any `postgres://` and nothing would notice.
    { name: 'a credential-FREE connection string is not flagged', files: { 'app.js': publicKeys + `const D="${U_NOCREDS}";\nconst U="${U_PLAIN}";\n` }, expect: 'clean' },
    // GENERIC ASSIGNMENTS, the shape with no vendor prefix at all. One control per FAMILY of the
    // narrow field list, so a mutation can disable one family without another covering for it.
    { name: 'deny: generic clientSecret assignment', files: { 'app.js': publicKeys + `const c={ ${L_CLIENTSEC}: "${V_GENERIC}" };\n` }, expect: 'fail' },
    { name: 'deny: generic jwtSecret assignment', files: { 'app.js': publicKeys + `const s={ ${L_JWTSEC}: "${V_JWT}" };\n` }, expect: 'fail' },
    { name: 'deny: generic secretKey assignment', files: { 'app.js': publicKeys + `const c={ ${L_SECRETKEY}: "${V_GENERIC}" };\n` }, expect: 'fail' },
    { name: 'deny: generic privateKey assignment', files: { 'app.js': publicKeys + `const c={ ${L_PRIVKEY}: "${V_GENERIC}" };\n` }, expect: 'fail' },
    { name: 'deny: generic refresh_token assignment', files: { 'app.js': publicKeys + `const c={ ${L_REFRESH}: "${V_GENERIC}" };\n` }, expect: 'fail' },
    // The AWS secret access key, in both shapes its field name actually takes. The value has no
    // prefix, so the field-name arm is the ONLY thing that can catch it.
    { name: 'deny: AWS-style secretAccessKey assignment', files: { 'app.js': publicKeys + `const c={ ${L_SAK_Q}: "${V_AWSSEC}" };\n` }, expect: 'fail' },
    { name: 'deny: unquoted aws_secret_access_key line', files: { 'app.js': publicKeys, '.env': `${L_SAK_U}=${V_AWSSEC}\n` }, expect: 'fail' },
    // Password-NAMED fields legitimately hold UI text: login forms and i18n tables ship exactly
    // this shape in every built bundle, since minifiers emit identifier keys unquoted. Whitespace
    // in the value is the separator: real credentials are space-free.
    { name: 'login-form UI text in password-named fields is NOT flagged', files: { 'app.js': publicKeys + `const M={ ${L_CONFIRM}: "Passwords do not match", ${L_FORGOT}: "Forgot your password?" };\n` }, expect: 'clean' },
    // THE NARROWING ITSELF, proven from the public side: apiKey and bare token are where PUBLIC
    // client keys live by convention (PostHog, Mixpanel, Algolia, Firebase), and a bare project
    // token is IDENTICAL in shape to a secret, so no allow list of value shapes can save a rule
    // that matches those fields. These two controls pin the field list narrow.
    { name: 'a public analytics apiKey assignment is not flagged (apiKey is not a secret-intent field)', files: { 'app.js': publicKeys + `posthog.init({ ${L_APIKEY}: "phc_${V_GENERIC}" });\n` }, expect: 'clean' },
    { name: 'a public analytics token assignment is not flagged (bare token is not a secret-intent field)', files: { 'app.js': publicKeys + `mixpanel.init({ ${L_TOKEN}: "${V_GENERIC}" });\n` }, expect: 'clean' },
    // A real vendored SDK in these bundles ships exactly this in a comment block. Flagging it is
    // how a gate earns a reputation for crying wolf and gets switched off.
    { name: 'a documentation example value is NOT flagged', files: { 'app.js': publicKeys + `/**\n *   ${L_ACCESSTOK}: '${V_DOCEX}',\n */\n` }, expect: 'clean' },
    // THE LAUNDERING CONTROL. A decoy example must not exonerate a real credential beside it. This
    // fails the moment the scan stops at the first match instead of trying every one.
    { name: 'a decoy example does NOT launder a real credential in the same file', files: { 'app.js': publicKeys + `const doc={ ${L_CLIENTSEC}: "${V_DECOY}" };\nconst real={ ${L_CLIENTSEC}: "${V_GENERIC}" };\n` }, expect: 'fail' },
    // The UNQUOTED form. Azure ships one semicolon-delimited string, and a .env line copied into a
    // bundle looks the same, so neither is visible to the quoted rule.
    { name: 'deny: Azure-style unquoted AccountKey', files: { 'app.js': publicKeys, 'cfg.txt': `${V_AZURE}\n` }, expect: 'fail' },
    { name: 'an unquoted documentation example is NOT flagged', files: { 'app.js': publicKeys, 'doc.txt': `# sample config\n${V_AZURE_DOC}\n` }, expect: 'clean' },
    // Credentials in an ordinary web URL. The connection-string rule lists database schemes only,
    // so this shape slipped past it entirely.
    { name: 'deny: credentials embedded in an http(s) URL', files: { 'app.js': publicKeys + `fetch("${U_BASIC}");\n` }, expect: 'fail' },
    { name: 'deny: connection string whose PASSWORD contains a colon', files: { 'app.js': publicKeys + `const D="${U_PG_COLON}";\n` }, expect: 'fail' },
    // THE ALLOW LIST, exercised through rules that still match broad field names. The UNQUOTED
    // rule keeps apiKey (a .env line uses it for real secrets), so a Firebase or Stripe
    // publishable value in that shape reaches isPublicByDesign and must be exempted THERE. The
    // anon JWT arrives through access_token, a secret-intent field on the narrow quoted list,
    // where only the role claim separates it from a service_role token. Without these controls,
    // the quoted rule's narrowing would leave every allow-list arm unreachable and unproven.
    { name: 'a Firebase web key in an unquoted config is public, not a finding', files: { 'app.js': publicKeys, 'cfg.txt': `${L_APIKEY}=${FIREBASE}\n` }, expect: 'clean' },
    { name: 'a Stripe publishable key in an unquoted config is public, not a finding', files: { 'app.js': publicKeys, 'cfg.txt': `${L_APIKEY}=${STRIPE_PK}\n` }, expect: 'clean' },
    { name: 'an anon JWT in an access_token assignment is public, not a finding', files: { 'app.js': `const c={ ${L_ACCESSTOK}: "${jwt('anon')}" };\n` }, expect: 'clean' },
    // NO CONTROL FOR THE service_role ARM, deliberately, and this is worth stating rather than
    // leaving as an apparent omission. `isPublicByDesign` refuses to exempt a service_role JWT, but
    // the dedicated JWT scan catches such a token anyway, from any position in the file. So the two
    // mechanisms are belt and braces and NO SINGLE mutation can redden a control over that arm:
    // disable either one and the other still reports it. A control written for it passed whatever
    // the arm did, which is the vacuity this harness exists to refuse, so it was removed rather
    // than kept as decoration. The arm stays because it is correct, and because it is the thing
    // that keeps the allow list from becoming a hole if the JWT scan is ever narrowed.
    // A suppressor marker that is really a common weak password, not a placeholder.
    { name: 'a password of changeme... is a real weak password, not a placeholder', files: { 'app.js': publicKeys + `const c={ ${L_PASSWORD}: "${V_WEAKPASS}" };\n` }, expect: 'fail' },
  ];

  let failures = 0;
  const roots = [];
  try {
    for (const c of cases) {
      const { root, dist } = fixtureDir(c.files);
      roots.push(root);
      const res = scan([dist]);
      const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
      const ok = got === c.expect;
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
    }
    // UNKNOWN controls - both false-clean paths get their own, because they are DIFFERENT branches:
    // an explicitly-passed dir that does not exist, and auto-detect finding no build dir at all.
    // Reporting either as clean is the silent false-clean this gate exists to prevent.
    const empty = mkdtempSync(join(tmpdir(), 'client-secrets-empty-'));
    roots.push(empty);
    const emptyRes = scan([join(empty, 'dist-does-not-exist')]);
    const emptyGot = emptyRes.unknown ? 'unknown' : (emptyRes.ok ? 'clean' : 'fail');
    if (emptyGot !== 'unknown') failures++;
    console.log(`  ${emptyGot === 'unknown' ? 'ok  ' : 'FAIL'}  an explicit missing dir is UNKNOWN, not clean  (expected unknown, got ${emptyGot})`);

    // Auto-detect path: no dirs passed AND no default build dir in cwd. Exercised by running from a
    // fresh empty dir, so a mutation that makes "no bundle found" report clean turns this control red.
    const noCwd = mkdtempSync(join(tmpdir(), 'client-secrets-nocwd-'));
    roots.push(noCwd);
    const prevCwd = process.cwd();
    let autoGot;
    try { process.chdir(noCwd); const r = scan([]); autoGot = r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); }
    finally { process.chdir(prevCwd); }
    if (autoGot !== 'unknown') failures++;
    console.log(`  ${autoGot === 'unknown' ? 'ok  ' : 'FAIL'}  auto-detect with no build dir is UNKNOWN, not clean  (expected unknown, got ${autoGot})`);

    // A not-exported Next.js app ships TWO browser surfaces: the chunks under `.next/static`, and
    // the PRE-RENDERED pages under `.next/server/pages`, served verbatim with `__NEXT_DATA__`
    // inlined. A key leaked through getStaticProps into pageProps lands only in the second. Both
    // controls run through AUTO-DETECT, because passing the directory explicitly always worked and
    // auto-detect is what silently reported "clean" over the surface it never read.
    const nextFixture = (files) => {
      const root = mkdtempSync(join(tmpdir(), 'client-secrets-next-'));
      roots.push(root);
      mkdirSync(join(root, '.next', 'static', 'chunks'), { recursive: true });
      writeFileSync(join(root, '.next', 'static', 'chunks', 'main.js'), publicKeys);
      for (const [rel, body] of Object.entries(files)) {
        const abs = join(root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body);
      }
      let got;
      try { process.chdir(root); const r = scan([]); got = r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); }
      finally { process.chdir(prevCwd); }
      return got;
    };

    const nextHtml = nextFixture({
      '.next/server/pages/index.html':
        `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"k":"${STRIPE_SK}"}}}</script>`,
    });
    if (nextHtml !== 'fail') failures++;
    console.log(`  ${nextHtml === 'fail' ? 'ok  ' : 'FAIL'}  a Next.js pre-rendered page's __NEXT_DATA__ is scanned  (expected fail, got ${nextHtml})`);

    // The other half, and it is not optional: scanning ALL of `.next/server` would flag a secret
    // in server code, where a secret is CORRECT. A gate that fails on legitimate server keys gets
    // switched off just as surely as one that misses real ones.
    const nextServer = nextFixture({ '.next/server/pages/api/pay.js': `const S="${STRIPE_SK}";\n` });
    if (nextServer !== 'clean') failures++;
    console.log(`  ${nextServer === 'clean' ? 'ok  ' : 'FAIL'}  Next.js SERVER code beside it is NOT flagged  (expected clean, got ${nextServer})`);

    // `.body` is the response body of a static Route Handler or metadata route, served verbatim.
    const nextBody = nextFixture({ '.next/server/app/config.body': `{"k":"${STRIPE_SK}"}` });
    if (nextBody !== 'fail') failures++;
    console.log(`  ${nextBody === 'fail' ? 'ok  ' : 'FAIL'}  a static Route Handler .body is scanned  (expected fail, got ${nextBody})`);

    // The restriction must attach to the directory WHEREVER it sits. Both controls below put a
    // server-only secret where a secret is CORRECT, and both were FLAGGED by the exact-string
    // version. The nested one needs no operator error: auto-detect hands over a top-level dir.
    const nested = fixtureDir({ 'app.js': publicKeys });
    roots.push(nested.root);
    mkdirSync(join(nested.dist, '.next', 'server', 'pages', 'api'), { recursive: true });
    writeFileSync(join(nested.dist, '.next', 'server', 'pages', 'api', 'pay.js'), `const S="${STRIPE_SK}";\n`);
    const nestedGot = (() => { const r = scan([nested.dist]); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (nestedGot !== 'clean') failures++;
    console.log(`  ${nestedGot === 'clean' ? 'ok  ' : 'FAIL'}  a .next/server NESTED under the scanned dir is restricted too  (expected clean, got ${nestedGot})`);

    const mono = fixtureDir({ 'app.js': publicKeys });
    roots.push(mono.root);
    const monoPages = join(mono.root, 'packages', 'web', '.next', 'server', 'pages');
    mkdirSync(join(monoPages, 'api'), { recursive: true });
    writeFileSync(join(monoPages, 'api', 'pay.js'), `const S="${STRIPE_SK}";\n`);
    writeFileSync(join(monoPages, 'index.html'), '<html>ok</html>');
    const monoGot = (() => { const r = scan([monoPages]); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (monoGot !== 'clean') failures++;
    console.log(`  ${monoGot === 'clean' ? 'ok  ' : 'FAIL'}  an explicitly passed monorepo .next/server/pages is restricted  (expected clean, got ${monoGot})`);

    // The shapes an operator actually TYPES. `.next` and `.next/server` both flagged legitimate
    // server code before, and ci-gates.yml tells a monorepo operator to pass a directory, so these
    // are the likely inputs rather than exotic ones.
    const verdictOf = (dirs) => { const r = scan(dirs); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); };
    const typedRoot = mkdtempSync(join(tmpdir(), 'client-secrets-typed-'));
    roots.push(typedRoot);
    const dotNext = join(typedRoot, '.next');
    mkdirSync(join(dotNext, 'server', 'pages', 'api'), { recursive: true });
    mkdirSync(join(dotNext, 'static', 'chunks'), { recursive: true });
    writeFileSync(join(dotNext, 'server', 'pages', 'api', 'pay.js'), `const S="${STRIPE_SK}";\n`);
    writeFileSync(join(dotNext, 'static', 'chunks', 'main.js'), publicKeys);
    // A browser-shipped file has to exist under `.next/server` or the restriction leaves NOTHING
    // to scan there and the honest verdict is UNKNOWN rather than clean. Caught by this control
    // expecting `clean` and getting `unknown`, which is the gate behaving correctly.
    writeFileSync(join(dotNext, 'server', 'pages', 'index.html'), '<html>ok</html>');
    // Directly under `.next/server`, OUTSIDE pages and app. Without this the fixture cannot tell
    // "the whole server tree is restricted" from "only pages and app are", because every file sat
    // under pages and both rules gave the same answer.
    mkdirSync(join(dotNext, 'server', 'chunks'), { recursive: true });
    writeFileSync(join(dotNext, 'server', 'chunks', 'handler.js'), `const S="${STRIPE_SK}";\n`);

    const typedServer = verdictOf([join(dotNext, 'server')]);
    if (typedServer !== 'clean') failures++;
    console.log(`  ${typedServer === 'clean' ? 'ok  ' : 'FAIL'}  a typed .next/server restricts its whole tree  (expected clean, got ${typedServer})`);

    const typedNext = verdictOf([dotNext]);
    if (typedNext !== 'clean') failures++;
    console.log(`  ${typedNext === 'clean' ? 'ok  ' : 'FAIL'}  a typed .next restricts server but keeps scanning static  (expected clean, got ${typedNext})`);

    // The TRAP guard, and the reason `.next` itself must never be matched: restricting `.next`
    // would restrict `.next/static` with it, so a real key in the client chunks would stop being
    // read. That trades a false positive for a FALSE CLEAN, which is strictly worse. This control
    // is what turns that reasoning into something a future edit cannot quietly undo.
    writeFileSync(join(dotNext, 'static', 'chunks', 'leak.js'), `const S="${STRIPE_SK}";\n`);
    const staticStillScanned = verdictOf([dotNext]);
    if (staticStillScanned !== 'fail') failures++;
    console.log(`  ${staticStillScanned === 'fail' ? 'ok  ' : 'FAIL'}  a key in .next/static is STILL caught when .next is passed  (expected fail, got ${staticStillScanned})`);

    // Same directory, differently spelled. Created literally as `.NEXT` so the control does not
    // depend on the host filesystem being case-insensitive, which would make it Windows-only.
    const spelled = mkdtempSync(join(tmpdir(), 'client-secrets-spell-'));
    roots.push(spelled);
    mkdirSync(join(spelled, '.NEXT', 'server', 'pages', 'api'), { recursive: true });
    writeFileSync(join(spelled, '.NEXT', 'server', 'pages', 'api', 'pay.js'), `const S="${STRIPE_SK}";\n`);
    writeFileSync(join(spelled, '.NEXT', 'server', 'pages', 'index.html'), '<html>ok</html>');
    // DIRECTLY in the passed directory, and that placement is the whole point. With the secret one
    // level down these controls were VACUOUS: path.join collapses separators as walk() descends, so
    // the restriction got re-derived correctly at the first subdirectory even with the normaliser
    // broken. Only a file in the target dir itself depends on the target string being normalised.
    writeFileSync(join(spelled, '.NEXT', 'server', 'pages', 'handler.js'), `const S="${STRIPE_SK}";\n`);
    const upper = verdictOf([join(spelled, '.NEXT', 'server', 'pages')]);
    if (upper !== 'clean') failures++;
    console.log(`  ${upper === 'clean' ? 'ok  ' : 'FAIL'}  an UPPERCASE .NEXT path is the same directory  (expected clean, got ${upper})`);

    const doubled = verdictOf([`${spelled}//.NEXT//server//pages`]);
    if (doubled !== 'clean') failures++;
    console.log(`  ${doubled === 'clean' ? 'ok  ' : 'FAIL'}  doubled separators are the same directory  (expected clean, got ${doubled})`);

    // Symlink ALIASING: a link named `.next/server/pages` pointing at a real CLIENT directory. The
    // restricted walk reached it first and put its resolved path in the seen-set, so the later
    // direct walk returned early and the client code was never scanned. SKIPPED, not passed, where
    // symlinks cannot be created, and the skip line keeps the SAME name so it stays the same
    // control in the mutants harness.
    try {
      const alias = fixtureDir({ 'app.js': publicKeys });
      roots.push(alias.root);
      const realClient = join(alias.dist, 'realclient');
      mkdirSync(realClient, { recursive: true });
      writeFileSync(join(realClient, 'leak.js'), `const S="${STRIPE_SK}";\n`);
      mkdirSync(join(alias.dist, '.next', 'server'), { recursive: true });
      symlinkSync(realClient, join(alias.dist, '.next', 'server', 'pages'), 'dir');
      const aliased = verdictOf([alias.dist]);
      if (aliased !== 'fail') failures++;
      console.log(`  ${aliased === 'fail' ? 'ok  ' : 'FAIL'}  a symlink aliasing a client dir under .next/server does not hide it  (expected fail, got ${aliased})`);
    } catch {
      console.log('  skip  a symlink aliasing a client dir under .next/server does not hide it  (host will not create symlinks)');
    }

    // The reported COUNT must be distinct files, not visits. A directory reachable under two
    // restrictions is walked twice by design, so a file passing both filters was collected twice
    // and the clean line inflated. No verdict was ever wrong, since findings dedupe, but that
    // number is the only thing the gate shows an operator on a clean run.
    try {
      const dup = fixtureDir({ 'app.js': publicKeys });
      roots.push(dup.root);
      const shared = join(dup.dist, 'shared');
      mkdirSync(shared, { recursive: true });
      for (const n of ['a.html', 'b.html', 'c.html']) writeFileSync(join(shared, n), '<html>ok</html>');
      mkdirSync(join(dup.dist, '.next', 'server'), { recursive: true });
      symlinkSync(shared, join(dup.dist, '.next', 'server', 'pages'), 'dir');
      const counted = scan([dup.dist]).scanned;
      const want = 4; // app.js plus three .html, each counted ONCE despite being walked twice
      if (counted !== want) failures++;
      console.log(`  ${counted === want ? 'ok  ' : 'FAIL'}  a file reachable twice is counted once  (expected ${want}, got ${counted})`);
    } catch {
      console.log('  skip  a file reachable twice is counted once  (host will not create symlinks)');
    }

    // EXIT-CODE controls. scan() decides the verdict, but report() decides the NUMBER the build
    // reads, and those are not the same thing: a found secret in an otherwise incomplete scan must
    // exit 1 (fail), never 2 (could not run), or a CI step that treats 2 as neutral ships the key.
    // report() writes to the console, so it is silenced here to keep the control output readable.
    const quietReport = (res) => {
      const err = console.error, log = console.log;
      console.error = () => {}; console.log = () => {};
      try { return report(res); } finally { console.error = err; console.log = log; }
    };
    const oneFinding = [{ file: 'dist/app.js', why: 'Stripe secret key' }];
    const exitCases = [
      ['a found secret in an INCOMPLETE scan exits 1, not 2', { unknown: true, reason: 'io error', findings: oneFinding }, 1],
      ['an incomplete scan with NO findings exits 2', { unknown: true, reason: 'io error', findings: [] }, 2],
      ['a found secret in a complete scan exits 1', { unknown: false, ok: false, findings: oneFinding }, 1],
      ['a clean complete scan exits 0', { unknown: false, ok: true, findings: [], scanned: 3 }, 0],
    ];
    for (const [name, res, want] of exitCases) {
      const got = quietReport(res);
      if (got !== want) failures++;
      console.log(`  ${got === want ? 'ok  ' : 'FAIL'}  ${name}  (expected exit ${want}, got ${got})`);
    }

    // CHUNKED-READ controls. A file past the size cap used to be called unreadable, which turned the
    // WHOLE scan UNKNOWN - so one big sourcemap disabled the gate. It is now read in overlapping
    // chunks. The limits are shrunk here so the control costs a few KB instead of a 21MB fixture on
    // every mutant run. The second case is the one that needs the OVERLAP: its key sits across a
    // chunk boundary and is invisible to any implementation that scans chunks independently.
    const pad = (n) => '/*' + 'x'.repeat(n) + '*/\n';
    const tiny = { maxBytes: 1024, chunkBytes: 1024 };
    const bigFile = fixtureDir({ 'huge.js': pad(3000) + `const S="${STRIPE_SK}";\n` });
    roots.push(bigFile.root);
    const bigGot = (() => { const r = scan([bigFile.dist], tiny); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (bigGot !== 'fail') failures++;
    console.log(`  ${bigGot === 'fail' ? 'ok  ' : 'FAIL'}  an oversized file is CHUNK-scanned, not called unreadable  (expected fail, got ${bigGot})`);

    const straddle = 'x'.repeat(1010 - 2) + `"${STRIPE_SK}"` + 'y'.repeat(2000);
    const strFile = fixtureDir({ 'straddle.js': straddle });
    roots.push(strFile.root);
    const strGot = (() => { const r = scan([strFile.dist], tiny); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (strGot !== 'fail') failures++;
    console.log(`  ${strGot === 'fail' ? 'ok  ' : 'FAIL'}  a key STRADDLING a chunk boundary is still caught (overlap)  (expected fail, got ${strGot})`);

    // Decoders must be chosen PER CHUNK. Choosing them once from chunk one made a big ASCII file
    // ending in a UTF-16 key report CLEAN, which is worse than the UNKNOWN that behaviour replaced.
    const mixed = fixtureDir({ 'mixed.js': Buffer.concat([Buffer.from(pad(3000)), Buffer.from(`const S="${STRIPE_SK}";`, 'utf16le')]) });
    roots.push(mixed.root);
    const mixedGot = (() => { const r = scan([mixed.dist], tiny); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (mixedGot !== 'fail') failures++;
    console.log(`  ${mixedGot === 'fail' ? 'ok  ' : 'FAIL'}  an ASCII first chunk does not disable UTF-16 decoding later  (expected fail, got ${mixedGot})`);

    // An ODD-length UTF-16BE file must still be read. Returning '' for it left the file unscanned,
    // and a single stray trailing byte was enough to trigger that.
    const beBody = Buffer.from(Buffer.from(`const S="${STRIPE_SK}";`, 'utf16le')).swap16();
    const oddBe = fixtureDir({ 'be.js': Buffer.concat([beBody, Buffer.from([0x0a])]) });
    roots.push(oddBe.root);
    const oddGot = (() => { const r = scan([oddBe.dist]); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (oddGot !== 'fail') failures++;
    console.log(`  ${oddGot === 'fail' ? 'ok  ' : 'FAIL'}  an ODD-length UTF-16BE file is still scanned  (expected fail, got ${oddGot})`);

    // A base64 data URI is atomic and can exceed any fixed overlap, so a long one straddling a
    // boundary needs the full-URI carry, not the credential-sized overlap.
    const longUri = 'data:application/json;base64,' + Buffer.from(`{"pad":"${'p'.repeat(4000)}","private_key":"${j('-----BEGIN PRIVATE ', 'KEY-----')}\\nMIIabc"}`).toString('base64');
    const uriFile = fixtureDir({ 'inline.js': 'x'.repeat(900) + longUri + 'y'.repeat(2000) });
    roots.push(uriFile.root);
    const uriGot = (() => { const r = scan([uriFile.dist], tiny); return r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail'); })();
    if (uriGot !== 'fail') failures++;
    console.log(`  ${uriGot === 'fail' ? 'ok  ' : 'FAIL'}  a data URI LONGER than the overlap, straddling a boundary  (expected fail, got ${uriGot})`);

    // The data-URI pattern must not backtrack quadratically. The unbounded version measured 759ms
    // at 32k and grew with the square of the input, which is minutes at bundle scale. The bound is
    // deliberately loose so a slow machine cannot make this flaky, and still catches that curve.
    // 128k of input, not 64k. At 64k the unbounded pattern measured 3279ms against a 2000ms budget,
    // a margin of only 1.64x - so on a machine under twice as fast the OLD regex would have passed
    // and this control would have stopped detecting anything, silently. The cost is quadratic, so
    // doubling the input quadruples that margin while the bounded pattern stays at roughly zero.
    const adversarial = 'data:text/' + 'a.+-'.repeat(32000) + '!';
    const t0 = Date.now();
    decodedDataUris(adversarial);
    const elapsed = Date.now() - t0;
    if (elapsed > 2000) failures++;
    console.log(`  ${elapsed <= 2000 ? 'ok  ' : 'FAIL'}  a long non-matching data: run does not backtrack (${elapsed}ms, budget 2000ms)`);

    // Argument handling, driven through main() directly. Both of these shipped as silent exit-0
    // paths that scanned nothing.
    // Both cases name a CLEAN fixture dir on purpose. `main(['--json'])` alone was VACUOUS: with
    // the guard deleted it fell through to auto-detect, found no bundle, and returned 2 - the very
    // code the control asserts - so it passed either way, and its result even depended on whether
    // the cwd happened to contain a ./dist. Naming a clean, scannable dir separates the outcomes:
    // refused is 2, fallen-through is 0. A control must fail for the reason it is named after.
    const cleanDir = fixtureDir({ 'app.js': publicKeys });
    roots.push(cleanDir.root);
    const argCases = [
      ['--selftest with a directory is refused, not silently run', ['--selftest', cleanDir.dist], 2],
      ['an unknown flag is refused, even when the scan would have succeeded', ['--json', cleanDir.dist], 2],
    ];
    for (const [name, argv, want] of argCases) {
      const err = console.error, log = console.log;
      console.error = () => {}; console.log = () => {};
      let got;
      try { got = main(argv); } finally { console.error = err; console.log = log; }
      if (got !== want) failures++;
      console.log(`  ${got === want ? 'ok  ' : 'FAIL'}  ${name}  (expected exit ${want}, got ${got})`);
    }

    // A genuinely unresolvable path must be UNKNOWN, never clean. A dangling symlink is the cheapest
    // portable way to reach that branch, and it is the branch that keeps an IO failure from reading
    // as a clean bundle. SKIPPED where the host forbids symlinks, never silently passed.
    try {
      const d = fixtureDir({ 'app.js': publicKeys });
      roots.push(d.root);
      symlinkSync(join(d.root, 'no-such-target.js'), join(d.dist, 'dangling.js'));
      const r = scan([d.dist]);
      const got = r.unknown ? 'unknown' : (r.ok ? 'clean' : 'fail');
      if (got !== 'unknown') failures++;
      console.log(`  ${got === 'unknown' ? 'ok  ' : 'FAIL'}  a dangling symlink is UNKNOWN, not clean  (expected unknown, got ${got})`);
    } catch (e) {
      // SAME control name as the ok/FAIL line above, with the reason in the trailing parenthetical
      // the harness strips. A control that renames itself when it skips stops being recognisable as
      // the same control, and the mutants harness then reports "expect names a control that does
      // not exist" - a stale-harness error - on any host that simply lacks the privilege.
      console.log(`  skip  a dangling symlink is UNKNOWN, not clean  (host will not create symlinks: ${(e && e.code) || 'error'})`);
    }

    // Symlink control: a symlinked secret FILE must be scanned, not silently skipped (the first
    // walk() skipped symlinks entirely - a false-clean). SKIPPED, not passed, on a host that forbids
    // symlink creation, so it never falsely goes green where it could not run.
    let symlinkRan = false, symlinkFail = false;
    try {
      const s = fixtureDir({ 'app.js': publicKeys });
      roots.push(s.root);
      const realSecret = join(s.root, 'secret-source.js');
      writeFileSync(realSecret, `const S="${STRIPE_SK}";\n`);
      symlinkSync(realSecret, join(s.dist, 'linked.js'));
      symlinkRan = true;
      const r = scan([s.dist]);
      symlinkFail = !r.unknown && !r.ok; // expect a FINDING: the secret reached via the link was scanned
    } catch { /* symlink creation not permitted here; control skips rather than fakes a pass */ }
    if (symlinkRan) {
      if (!symlinkFail) failures++;
      console.log(`  ${symlinkFail ? 'ok  ' : 'FAIL'}  a symlinked secret file is scanned, not skipped  (expected fail)`);
    } else {
      console.log('  skip  a symlinked secret file is scanned, not skipped  (host will not create symlinks)');
    }

    // THE LINK NAME IS NOT THE FILE. The control above cannot catch this, because its link is named
    // `linked.js`, which passes the name filters whether they read the link or the target. Here the
    // link is named like an image while the target is real code holding a key: judging by `ent.name`
    // drops it unread and reports clean. Same skip-not-pass rule as above.
    let binLinkRan = false, binLinkFail = false;
    try {
      const s = fixtureDir({ 'app.js': publicKeys });
      roots.push(s.root);
      const realSecret = join(s.root, 'real-secret.js');
      writeFileSync(realSecret, `const S="${STRIPE_SK}";\n`);
      symlinkSync(realSecret, join(s.dist, 'logo.png')); // link LOOKS binary, target is code
      binLinkRan = true;
      const r = scan([s.dist]);
      binLinkFail = !r.unknown && !r.ok;
    } catch { /* symlink creation not permitted here; control skips rather than fakes a pass */ }
    if (binLinkRan) {
      if (!binLinkFail) failures++;
      console.log(`  ${binLinkFail ? 'ok  ' : 'FAIL'}  a binary-NAMED symlink to a secret file is still scanned  (expected fail)`);
    } else {
      console.log('  skip  a binary-NAMED symlink to a secret file is still scanned  (host will not create symlinks)');
    }

    // THE OTHER DIRECTION, and the one a target-only fix silently broke. Inside `.next/server` the
    // name test is an ALLOWLIST, so an EXTENSIONLESS target (a content-addressed store entry, the
    // common shape for a linked build artifact) fails it and the browser-shipped page it stands for
    // goes unread. The control above cannot see this: it lives in an unrestricted tree where the
    // denylist runs instead. Both filters must accept EITHER name, so this stays a finding.
    let uriLinkRan = false, uriLinkFail = false;
    try {
      const nx = mkdtempSync(join(tmpdir(), 'client-secrets-nextlink-'));
      roots.push(nx);
      mkdirSync(join(nx, '.next', 'static', 'chunks'), { recursive: true });
      writeFileSync(join(nx, '.next', 'static', 'chunks', 'main.js'), publicKeys);
      mkdirSync(join(nx, '.next', 'server', 'pages'), { recursive: true });
      mkdirSync(join(nx, 'store'), { recursive: true });
      const storeEntry = join(nx, 'store', 'e3b0c44298fc1c14'); // no extension, on purpose
      writeFileSync(storeEntry, `<script id="__NEXT_DATA__">{"pageProps":{"k":"${STRIPE_SK}"}}</script>`);
      symlinkSync(storeEntry, join(nx, '.next', 'server', 'pages', 'index.html'));
      uriLinkRan = true;
      const r = scan([join(nx, '.next')]);
      uriLinkFail = !r.unknown && !r.ok;
    } catch { /* symlink creation not permitted here; control skips rather than fakes a pass */ }
    if (uriLinkRan) {
      if (!uriLinkFail) failures++;
      console.log(`  ${uriLinkFail ? 'ok  ' : 'FAIL'}  a browser-shipped symlink to an EXTENSIONLESS target is still scanned  (expected fail)`);
    } else {
      console.log('  skip  a browser-shipped symlink to an EXTENSIONLESS target is still scanned  (host will not create symlinks)');
    }
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* temp cleanup */ } }
  }

  if (failures) { console.error(`[client-secrets] selftest: ${failures} control(s) FAILED`); return 1; }
  console.log('[client-secrets] selftest: all controls passed');
  return 0;
}

// --- main -----------------------------------------------------------------
function usage(problem) {
  console.error(`[client-secrets] ${problem}`);
  console.error('Usage: check-client-secrets.mjs [dir ...]   scan built client output (auto-detects if omitted)');
  console.error('       check-client-secrets.mjs --selftest  prove the gate still fires');
}

// argv is a PARAMETER so the selftest can drive argument handling directly. Reading process.argv
// inside would have forced a subprocess to test it, and the two argument bugs below both shipped
// precisely because nothing exercised this function.
function main(argv) {
  const args = argv || process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const dirs = args.filter((a) => !a.startsWith('--'));
  // An UNRECOGNISED flag used to be dropped silently. The damaging shape was an invocation whose
  // arguments were ALL flags, e.g. a bare `--json`: the directory list came out empty, so the gate
  // fell back to auto-detect and reported on whatever default dir happened to exist rather than
  // telling the caller the option meant nothing.
  const unknownFlags = flags.filter((a) => a !== '--selftest');
  if (unknownFlags.length) {
    usage(`unknown option(s): ${unknownFlags.join(', ')}`);
    return 2;
  }
  // This check sits BEFORE --selftest is dispatched, because it used to sit after:
  // `check-client-secrets.mjs --selftest dist` then printed "all controls passed" and exited 0
  // while `dist`, the bundle the caller actually named, was never scanned. A zero exit from a run
  // that silently scanned nothing is exactly the false-clean this gate exists to prevent.
  if (flags.includes('--selftest')) {
    if (dirs.length) {
      usage(`--selftest does not scan a directory, but ${dirs.length} was given (${dirs.join(', ')}). Run it without one, or drop --selftest to scan.`);
      return 2;
    }
    return selftest();
  }
  return report(scan(dirs));
}

// Run when this file is the entry point, whatever it is NAMED - the mutants harness copies this
// source under a different filename and must still execute the selftest, so a basename match fails.
const normPath = (p) => p.replace(/\\/g, '/').toLowerCase();
let isEntry = false;
try { isEntry = !!process.argv[1] && normPath(realpathSync(process.argv[1])) === normPath(fileURLToPath(import.meta.url)); } catch { /* argv[1] unreadable */ }
if (isEntry) process.exit(main());

export { scan, DENY, jwtRole };
