import { defineConfig } from "vitest/config";

/**
 * The suite the mutation run uses, which is deliberately not the whole suite.
 *
 * Everything in `test/` runs inside a Workers isolate against a real D1, because that is the only
 * honest way to test a Durable Object and a database. Running that per mutant would take hours and
 * measure the platform as much as the code. The modules below are pure decisions with pure tests
 * beside them, so they run in a plain Node process in about a second, which is what makes a real
 * mutation score affordable.
 *
 * The cost of that choice is written down rather than hidden: `stryker.config.json` mutates only
 * the modules this config can actually kill mutants in, and `COVERAGE.md` says which parts of the
 * product are therefore outside the score.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.stryker-tmp/**"],
    environment: "node",
  },
});
