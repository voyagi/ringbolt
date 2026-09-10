#!/usr/bin/env node
// ensure-dev-vars.mjs - give a clean checkout the local settings file before the dev server starts.
//
// WHY THIS EXISTS
// Wrangler reads local settings from `.dev.vars`, which is gitignored and therefore absent from
// every fresh clone. When it is absent, `wrangler dev` falls back to the `vars` block in
// `wrangler.jsonc`, and that block describes the DEPLOYED service: production, with the deployed
// hostname as the address calls report back to. A developer following the README then gets a local
// server that refuses its own documented `/intake/dev` request with a 503, refuses the whole
// configuration API, and points the stand-in's callbacks at the live deployment.
//
// Before the deployment existed that fallback happened to be harmless, because the committed vars
// still said development and localhost. That is exactly what made it worth fixing rather than
// documenting: the setup was resting on the deployed configuration never being written down.
//
// `.env.example` is tracked and its first line already says to copy it. Prose cannot be relied on
// to run, so this does it.
//
// It never overwrites an existing `.dev.vars`. Somebody's real key, number and spending cap live in
// that file.
//
// Usage:
//   node scripts/ensure-dev-vars.mjs              create it when missing, do nothing when present
//   node scripts/ensure-dev-vars.mjs --selftest   prove both halves of that sentence
//
// Exit codes: 0 there is a local settings file, 1 there is not and one could not be made.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} root directory holding `.dev.vars` and `.env.example`
 * @returns {'present' | 'created'}
 */
function ensureDevVars(root) {
  const devVars = join(root, '.dev.vars');
  if (existsSync(devVars)) return 'present';

  const example = join(root, '.env.example');
  if (!existsSync(example)) {
    throw new Error(
      'no .dev.vars and no .env.example to make one from. Wrangler would read the deployed ' +
        'configuration instead, so the local server would run as production. Restore ' +
        '.env.example, or write .dev.vars by hand with RINGBOLT_ENV=development.',
    );
  }

  copyFileSync(example, devVars);
  return 'created';
}

function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'ringbolt-dev-vars-'));
  try {
    writeFileSync(join(root, '.env.example'), 'RINGBOLT_ENV=development\n');

    if (ensureDevVars(root) !== 'created') throw new Error('selftest: did not create a missing .dev.vars');
    if (!existsSync(join(root, '.dev.vars'))) throw new Error('selftest: reported created and wrote nothing');

    // The half that matters more. A rerun must not walk over a file holding a real credential.
    writeFileSync(join(root, '.dev.vars'), 'CALLE_API_KEY=someone-real\n');
    if (ensureDevVars(root) !== 'present') throw new Error('selftest: did not recognise an existing .dev.vars');
    const kept = readFileSync(join(root, '.dev.vars'), 'utf8');
    if (!kept.includes('someone-real')) throw new Error('selftest: overwrote an existing .dev.vars');

    // And it must refuse rather than leave the caller believing there is a settings file.
    const bare = mkdtempSync(join(tmpdir(), 'ringbolt-dev-vars-bare-'));
    try {
      let refused = false;
      try {
        ensureDevVars(bare);
      } catch {
        refused = true;
      }
      if (!refused) throw new Error('selftest: did not refuse with no .env.example to copy');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }

    console.log('[dev-vars] selftest passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  try {
    const outcome = ensureDevVars(repoRoot);
    if (outcome === 'created') {
      console.log('[dev-vars] wrote .dev.vars from .env.example. It is gitignored: put your own key, number and spending cap in it before switching CALLE_MODE to live.');
    }
  } catch (error) {
    console.error(`[dev-vars] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
