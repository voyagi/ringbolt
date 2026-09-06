import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// What the pool's `env` carries beyond the bindings `wrangler types` generates from wrangler.jsonc.
// Secrets are never in that file, so the tokens the worker reads by name are absent from the
// generated type, and the stand-in's knobs only exist in `vitest.config.ts`. The suite sets and
// deletes these between cases, so they are optional and may hold undefined.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      ADMIN_TOKEN?: string | undefined;
      INTAKE_TOKEN?: string | undefined;
      CALLE_FAKE_SCENARIO?: string | undefined;
      DEMO_MODE?: string | undefined;
      // The worker's own `Bindings` type reads secrets by name through an index signature, and an
      // interface has none unless it declares one. This is what lets `env` be handed straight to
      // buildOrchestrator, buildPlacer and reconcile. Nothing in src/ names this global type.
      [binding: string]: unknown;
    }
  }
}
