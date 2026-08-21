// Architecture-boundary rules = externalized memory (the rule file IS the documented architecture).
// NARROW: only boundaries that genuinely must not be crossed, each an error. EDIT the path regexes
// to the product's real layers; keep the set small and meaningful (a wall nobody respects is noise).
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'no-ui-to-server',
      severity: 'error',
      // SECURITY-RELEVANT + LAYOUT-SPECIFIC. These regexes assume an src/ui|client|components vs
      // src/server split. If they match NO files (a different layout - app/, apps/web/, lib/server),
      // depcruise reports 0 violations and this protection SILENTLY does not apply (false assurance).
      // ALWAYS adapt the paths to the real layers AND smoke-test it (plant a ui->server import, see it
      // fail). Do NOT just broaden to `app/ -> server/`: a Next.js app/ legitimately imports server
      // code (server components / route handlers), so that would false-positive instead.
      comment: 'Client/UI code must not import server-only modules (would leak secrets/Node APIs into the bundle).',
      from: { path: '^src/(ui|client|components)' },
      to: { path: '^src/server' },
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
