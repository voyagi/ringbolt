import { z } from "zod";

/**
 * Workers hand configuration to each request through a binding rather than `process.env`, so the
 * boot-time validation pattern used elsewhere cannot run here. This is the equivalent: parse once
 * at the edge of the request and refuse to serve on a bad configuration rather than failing
 * halfway through placing a phone call.
 */
const shared = {
  RINGBOLT_ENV: z.enum(["development", "preview", "production"]),
  PUBLIC_BASE_URL: z.url(),
  INTAKE_TOKEN: z.string().min(16).optional(),
  /** How long the local stand-in waits before a call reaches a terminal state. Fake mode only. */
  CALLE_FAKE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(1200),
};

/**
 * E.164, and strict about it. A country code cannot begin with a zero, so the placeholder number
 * the stand-in carries can never satisfy this and can never be dialled by accident.
 */
const phoneNumber = z
  .string()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "must be an E.164 phone number, for example +31612345678",
  );

/**
 * Split by mode rather than validated afterwards, so that the two things a telephone needs are
 * carried by the type. Code holding a live configuration has an API key and a number to dial
 * without asking, and code that forgot to check the mode will not compile.
 */
const envSchema = z.discriminatedUnion("CALLE_MODE", [
  z.object({
    ...shared,
    CALLE_MODE: z.literal("fake"),
    CALLE_API_KEY: z.string().optional(),
    DEMO_PHONE: z.string().optional(),
  }),
  z.object({
    ...shared,
    CALLE_MODE: z.literal("live"),
    CALLE_API_KEY: z.string().min(1),
    DEMO_PHONE: phoneNumber,
  }),
]);

export type RingboltConfig = z.infer<typeof envSchema>;

/**
 * Whether this build may reach a telephone at all. It is a switch rather than a fact about the
 * code, because the real-call allowance is twenty and cannot be topped up: setting this to false
 * refuses live mode in every environment at once, without editing configuration that the next
 * deploy would restore.
 */
export const LIVE_MODE_AVAILABLE: boolean = true;

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

export function readConfig(
  env: unknown,
  options: { liveAvailable?: boolean } = {},
): RingboltConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    );
  }

  const config = parsed.data;
  if (
    config.CALLE_MODE === "live" &&
    !(options.liveAvailable ?? LIVE_MODE_AVAILABLE)
  ) {
    throw new ConfigurationError([
      "CALLE_MODE is live but this build has live calling switched off. Set CALLE_MODE=fake.",
    ]);
  }

  return config;
}
