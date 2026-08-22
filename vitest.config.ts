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
          CALLE_API_KEY: "test-key-not-a-real-credential",
          // Third layer. Country code 999 is unassigned, so this is a well-formed number that no
          // telephone network can route. A live placer reaching dial would ring nothing.
          DEMO_PHONE: "+99900000000",
          // The stand-in's think time only exists so a demo looks like a real call.
          CALLE_FAKE_DELAY_MS: "20",
          INTAKE_TOKEN: "test-intake-token-0123456789",
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
      "**/*.fault.test.ts",
      "**/*.fault.example.test.ts",
    ],
  },
});
