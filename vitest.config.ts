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
        bindings: {
          TEST_MIGRATIONS: migrations,
          // The stand-in's think time only exists so a demo looks like a real call.
          CALLE_FAKE_DELAY_MS: "20",
          INTAKE_TOKEN: "test-intake-token-0123456789",
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
