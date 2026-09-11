import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // These win over `.dev.vars`, which is what makes the three below a guarantee rather than
        // a convention. On 2026-08-22 the suite was run while `.dev.vars` said `CALLE_MODE=live`,
        // and it did what it was told: the tests built the real telephone from the real key and
        // rang a real number three times. A test run must not be able to reach a telephone because
        // of a file somebody edited for an unrelated reason, so it no longer can.
        bindings: {
          TEST_MIGRATIONS: migrations,
          // First layer. The suite runs against the stand-in, always, whatever the environment says.
          CALLE_MODE: "fake",
          // Second layer. Even a test that built a live placer could not authenticate.
          CALLE_API_KEY: "test-dummy-key-not-a-real-credential",
          // Third layer. Country code 999 is unassigned, so this is a well-formed number that no
          // telephone network can route. A live placer reaching dial would ring nothing.
          DEMO_PHONE: "+99900000000",
          // Fourth layer, and the one that was missing on 2026-09-08: the suite read the spending
          // cap an operator had just written into `.dev.vars` for a real call, and a test that
          // expects a fresh build to have nothing to spend failed on their money. A test that needs
          // credit says so in its own configuration.
          CALLE_CREDIT_USD: "0",
          // The stand-in's think time only exists so a demo looks like a real call.
          CALLE_FAKE_DELAY_MS: "20",
          // Fifth layer, and the one that was missing on 2026-09-10: everything above pins a value
          // the suite must not inherit, and then the suite inherited the two that decide who may
          // read an estate and where a call reports back to. Both came from `.dev.vars` on a
          // developer's machine and from `wrangler.jsonc` everywhere else, so the day the deployed
          // configuration said `production` the whole configuration API answered 503 in CI while
          // every local run stayed green. A suite that passes only where an untracked file exists
          // is not a suite. Tests that need `production` set it themselves, per test.
          RINGBOLT_ENV: "development",
          // The same fix, and the sharper half of it. The stand-in delivers its webhook to
          // PUBLIC_BASE_URL, and `test/support/webhook.ts` is written around nothing listening
          // there. Inheriting the deployed value would have pointed that delivery at the live
          // deployment. `.test` is reserved and never resolves, so it cannot reach anything.
          PUBLIC_BASE_URL: "https://webhooks.ringbolt.test",
          INTAKE_TOKEN: "test-dummy-intake-token-0123456789",
          // The same idea one layer out. A runbook action is a row in a table, and a test can write
          // one, so the suite pins the only host any action it defines is allowed to reach. That
          // name does not resolve, so an action stored by a test cannot touch anybody's system.
          ACTION_HOST_ALLOWLIST: "actions.ringbolt.test",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // A mutation run copies the whole project into here, and a crashed one leaves the copy
      // behind. Without this the next `npm test` collects those copies as well, runs every test
      // twice, and reports failures from code with a mutant still in it. That happened.
      "**/.stryker-tmp/**",
      "**/reports/**",
      "**/*.fault.test.ts",
      "**/*.fault.example.test.ts",
    ],
  },
});
