import { z } from "zod";
import { actionUrlProblem } from "../actions/definition.js";
import { fakeScenarioKinds } from "../calle/fake.js";
import { phoneNumber } from "../domain/rotation.js";

/**
 * Workers hand configuration to each request through a binding rather than `process.env`, so the
 * boot-time validation pattern used elsewhere cannot run here. This is the equivalent: parse once
 * at the edge of the request and refuse to serve on a bad configuration rather than failing
 * halfway through placing a phone call.
 */
/**
 * A dotenv file spells "not set" as a name with nothing after the equals sign, and `.env.example`
 * ships exactly that for every value an operator fills in later. Reading a blank as absent is what
 * makes that file copyable: without it, copying it and starting the stand-in fails on an intake
 * token nobody had set yet, and a blank API key in live mode complains about its length rather
 * than saying it is missing.
 */
function blankIsAbsent<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

const shared = {
  RINGBOLT_ENV: z.enum(["development", "preview", "production"]),
  PUBLIC_BASE_URL: z.url(),
  INTAKE_TOKEN: blankIsAbsent(z.string().min(16).optional()),
  /**
   * Guards everything that edits policy, contacts, or the rotation. Those endpoints decide which
   * number gets dialled, so outside development they refuse to serve at all until this is set:
   * authentication proper is phase 7, and an unguarded write here is a stranger's phone ringing.
   */
  ADMIN_TOKEN: blankIsAbsent(z.string().min(16).optional()),
  /** How long the local stand-in waits before a call reaches a terminal state. Fake mode only. */
  CALLE_FAKE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(1200),
  /**
   * Which outcome the local stand-in rehearses. The point of a stand-in is the failure modes, not
   * the happy path, so choosing which one it produces is how the escalation and refusal paths get
   * exercised without spending any of the twenty real calls.
   */
  CALLE_FAKE_SCENARIO: blankIsAbsent(
    z.enum(fakeScenarioKinds).default("answers"),
  ),
  /**
   * Every host a runbook action may call, comma separated. The same argument as the phone number
   * allowlist: an action definition is a row in a table that the configuration API writes, so
   * without this the set of systems a deployment can reach is whatever somebody typed into it.
   * Leaving it out is allowed in development only, and outside development it means no action may
   * call anything at all, which fails towards doing nothing.
   */
  ACTION_HOST_ALLOWLIST: blankIsAbsent(
    z
      .string()
      .max(500)
      .refine(
        (value) => splitList(value).every(isCallableHost),
        "must be public host names separated by commas, and each one has to be a host an action is allowed to call",
      )
      .optional(),
  ),
};

/**
 * Split by mode rather than validated afterwards, so that the two things a telephone needs are
 * carried by the type. Code holding a live configuration has an API key and a number to dial
 * without asking, and code that forgot to check the mode will not compile.
 */
const envSchema = z.discriminatedUnion("CALLE_MODE", [
  z.object({
    ...shared,
    CALLE_MODE: z.literal("fake"),
    CALLE_API_KEY: blankIsAbsent(z.string().optional()),
    DEMO_PHONE: blankIsAbsent(z.string().optional()),
  }),
  z.object({
    ...shared,
    CALLE_MODE: z.literal("live"),
    CALLE_API_KEY: blankIsAbsent(z.string().min(1)),
    DEMO_PHONE: blankIsAbsent(phoneNumber),
    /**
     * Every number this build may ring, comma separated. The rotation can name any contact anyone
     * has added through the configuration endpoint, so without this the set of telephones a live
     * build can reach is a database table. It is a short list in the deployment configuration
     * instead, which is the only place a number can be added on purpose.
     */
    LIVE_CALL_ALLOWLIST: blankIsAbsent(
      z
        .string()
        .refine(
          (value) => splitList(value).every(isE164),
          "must be E.164 phone numbers separated by commas, for example +31612345678,+31698765432",
        )
        .optional(),
    ),
  }),
]);

export type RingboltConfig = z.infer<typeof envSchema>;
export type LiveConfig = Extract<RingboltConfig, { CALLE_MODE: "live" }>;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function isE164(value: string): boolean {
  return phoneNumber.safeParse(value).success;
}

/**
 * A host is allowed onto the list only if an action would have been allowed to call it, which is
 * the same check the definition and the executor make. Reusing it is the point: a name that the
 * url rule refuses cannot be smuggled past it by being written into the allowlist instead.
 */
function isCallableHost(value: string): boolean {
  return actionUrlProblem(`https://${value}/`) === null;
}

/**
 * The hosts a runbook action may call, or null when there is no restriction, which only happens in
 * development. An unset allowlist anywhere else yields an empty list: no host, so no action that
 * reaches outside can run at all until an operator names one.
 */
export function allowedActionHosts(
  config: RingboltConfig,
): readonly string[] | null {
  const configured = config.ACTION_HOST_ALLOWLIST;
  if (configured === undefined) {
    return config.RINGBOLT_ENV === "development" ? null : [];
  }
  return splitList(configured).map((host) => host.toLowerCase());
}

/**
 * The numbers a live build may dial. The configured demo number is always on it: it is what the
 * fallback responder uses when no rotation has been set up, so leaving it off would mean a build
 * that cannot ring the one number its own configuration names.
 */
export function allowedLiveNumbers(config: LiveConfig): string[] {
  const configured = config.LIVE_CALL_ALLOWLIST;
  if (configured === undefined) return [config.DEMO_PHONE];

  const numbers = splitList(configured);
  return numbers.includes(config.DEMO_PHONE)
    ? numbers
    : [...numbers, config.DEMO_PHONE];
}

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
