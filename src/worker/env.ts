import { z } from "zod";

/**
 * Workers hand configuration to each request through a binding rather than `process.env`, so the
 * boot-time validation pattern used elsewhere cannot run here. This is the equivalent: parse once
 * at the edge of the request and refuse to serve on a bad configuration rather than failing
 * halfway through placing a phone call.
 */
const envSchema = z.object({
  RINGBOLT_ENV: z.enum(["development", "preview", "production"]),
  CALLE_MODE: z.enum(["fake", "live"]),
  PUBLIC_BASE_URL: z.url(),
  CALLE_API_KEY: z.string().min(1).optional(),
  INTAKE_TOKEN: z.string().min(16).optional(),
  /** How long the local stand-in waits before a call reaches a terminal state. Fake mode only. */
  CALLE_FAKE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(1200),
});

export type RingboltConfig = z.infer<typeof envSchema>;

/**
 * Whether a build of Ringbolt can actually reach CALL-E. Phase 2 writes that adapter and flips this
 * to true in the same commit. Until then `live` is refused here, at the configuration boundary,
 * rather than at the moment a phone was supposed to ring: an operator who follows a go-live
 * procedure has to be told by the health check, not by every intake returning a five hundred.
 */
export const LIVE_MODE_AVAILABLE: boolean = false;

export type Bindings = {
  DB: D1Database;
  INCIDENT: DurableObjectNamespace;
} & Record<string, unknown>;

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Ringbolt is misconfigured: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
  }
}

export function readConfig(env: unknown): RingboltConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    );
  }

  const config = parsed.data;
  if (config.CALLE_MODE === "live") {
    if (!LIVE_MODE_AVAILABLE) {
      throw new ConfigurationError([
        "CALLE_MODE is live but this build has no CALL-E adapter, so no call can be placed. Set CALLE_MODE=fake.",
      ]);
    }
    if (config.CALLE_API_KEY === undefined) {
      throw new ConfigurationError([
        "CALLE_MODE is live but CALLE_API_KEY is not set",
      ]);
    }
  }

  return config;
}
