// Complexity budgets + cross-browser compat - the ESLint half of the Wave 1 scaffold gates.
// MERGE these blocks into the product's existing flat config; do not blanket-replace it.
//
// Thresholds are HIGH (25) on purpose: a FLOOR, not a style nag. Proven on a real repo - at 15,
// hand-written code (deslop-kit's scan(), cyclo 28 / cognitive 40) tripped, which erodes trust. 25
// (~2x the common 15) fires only on genuinely tangled functions. A hit = review/refactor the hotspot
// or raise it for that one file WITH a written reason; never blanket-disable (that is itself a tell).
import sonarjs from 'eslint-plugin-sonarjs';
import compat from 'eslint-plugin-compat';
import tseslint from 'typescript-eslint';

const tsParser = { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } };

export default [
  // Exclude tests/specs/config + build output from the floors: test files legitimately get
  // complex (big describe/it trees) and config files are generated-ish, so running complexity on
  // them false-positives on code that is not shipped product.
  {
    ignores: [
      '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.config.{ts,js,mjs,cjs}',
      '**/{dist,build,coverage}/**',
      // Vendored gate tooling, copied in whole and never edited here. The complexity floors exist
      // to keep THIS product's code readable, and applying them to a checker we did not write and
      // must not modify would only ever produce a suppression. Ringbolt's own scripts are linted.
      'scripts/vendor/**',
      'verify-ship.mjs',
      // Emitted by `wrangler types` on every config change, and not committed.
      'worker-configuration.d.ts',
      // Needs the fault-lane dependencies, installed in the attack pass.
      'test/fault/**',
    ],
  },
  // Complexity budgets - ALL source files. Only these two sonarjs/core rules (NOT the full
  // sonarjs recommended set, which is a wide false-positive surface).
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: { ...tsParser },
    plugins: { sonarjs },
    rules: {
      complexity: ['error', 25],
      'sonarjs/cognitive-complexity': ['error', 25],
    },
  },
  // Cross-browser / Baseline gate - CLIENT/browser code ONLY. Run on Node/backend code it
  // false-positives on Node-valid syntax (e.g. regex lookbehind "unsupported in Safari 13").
  // EDIT these globs to the product's actual client entry points. Browserslist is read from
  // package.json / .browserslistrc - set it to the product's real support target, and ALWAYS keep
  // `not op_mini all` (see .browserslistrc): Opera Mini is in `defaults` but supports almost no
  // modern API, so without excluding it compat false-positives on fetch/Promise/structuredClone in
  // normal code (proven: 20 false hits on a real product, zero after the exclusion).
  // The `**/*.{jsx,tsx}` catch-all assumes JSX/TSX = client UI (true for React). If the product
  // has SERVER-side .tsx (rare), add it to `ignores` here so compat does not false-positive on it.
  // COVERAGE GAP (proven 2026-06-25): a NON-.tsx browser file OUTSIDE the named dirs - e.g.
  // src/{lib,utils,hooks,services}/*.ts calling fetch/structuredClone - is NOT checked by these
  // globs and ships unverified. Add your product's real client dirs to the list above. It is NOT
  // auto-broadened because Node 18+ exposes fetch/structuredClone as globals, so widening to a
  // generic `lib/` would false-positive on a backend product. Smoke-test by linting one known
  // client file and confirming compat actually runs on it.
  {
    files: ['**/{ui,client,components,pages,app}/**/*.{ts,tsx,js,jsx,mjs}', '**/*.{jsx,tsx}'],
    languageOptions: { ...tsParser },
    plugins: { compat },
    rules: { 'compat/compat': 'error' },
  },
];
