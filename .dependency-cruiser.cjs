// Architecture-boundary rules. This file IS the documented architecture, which is the point: a
// boundary written only in a README is a boundary nobody can fail.
//
// Deliberately narrow. Only boundaries that genuinely must not be crossed are listed, and each is
// an error rather than a warning, because a wall nobody respects is noise.
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'no-ui-to-server',
      severity: 'error',
      // SECURITY-RELEVANT AND LAYOUT-SPECIFIC. This rule once pointed at `^src/server`, a path
      // that does not exist here, so it matched nothing and reported a clean run while protecting
      // nothing at all. The paths below are Ringbolt's real layers, checked against the tree.
      //
      // `src/ui` is the browser bundle a stranger can read. Everything named on the `to` side
      // reaches D1, a Durable Object, the CALL-E key, or a runbook credential, and one import from
      // a screen would carry it into that bundle.
      //
      // `src/domain/view.ts` is the single deliberate exception: it is the contract both halves
      // read and it has no imports of its own, which `src/domain/view.test.ts` asserts, because a
      // boundary with one module through it stops being a boundary the moment that module grows an
      // import. Everything else in `src/domain` pulls zod and the state machine with it.
      //
      // Smoke-tested by planting `import { Repo } from "../db/repo.js"` in a screen and watching
      // this fail. A boundary rule nobody has seen fail is a boundary rule nobody knows works.
      comment: 'The dashboard bundle must not import server-only modules: they carry the database, the telephone credential and the runbook secrets.',
      from: { path: '^src/ui' },
      to: {
        path: '^src/(worker|db|calle|actions|domain|demo)',
        pathNot: '^src/domain/view\\.ts$',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about, test, and tree-shake.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (imported by nothing) are usually dead code - confirm or delete.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)(index|main|entry)\\.[jt]sx?$', '\\.config\\.[jt]s$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // tsConfig ONLY when the project actually has one (it improves TS path-alias resolution).
    // Hardcoding it makes depcruise ERROR "Cannot read file 'tsconfig.json'" and exit 1 on a
    // JS-only product (verified 2026-06-25). Resolve against __dirname (the config's own dir =
    // product root), not a cwd-relative name, so the check is correct no matter where depcruise is
    // invoked from (a subdirectory, a monorepo package).
    ...(fs.existsSync(path.join(__dirname, 'tsconfig.json'))
      ? { tsConfig: { fileName: path.join(__dirname, 'tsconfig.json') } }
      : {}),
    // Without this, `import type` edges are invisible, so a types-only module looks like dead code
    // and, worse, a boundary crossed only by a type import would pass a rule meant to forbid it.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'] },
  },
};
