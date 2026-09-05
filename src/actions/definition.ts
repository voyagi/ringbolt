import { z } from "zod";

/**
 * What an action is, as an operator writes it down. Nothing in here is code: a definition is a row,
 * and the engine compiles it into something runnable at the moment a call is placed.
 */

export const actionIdPattern = /^[a-z][a-z0-9_]{2,39}$/;

/** Bindings an action may read a credential from. The prefix is what keeps a definition from
 * naming any other binding this Worker happens to have, the CALL-E key among them. */
export const secretBindingPattern = /^RUNBOOK_SECRET_[A-Z0-9_]{1,40}$/;

const placeholder = /\{([a-z][a-z0-9_]{0,39})\}/g;

const parameterName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,39}$/,
    "a parameter name is lower case letters, digits and underscores",
  );

const sharedParameter = {
  name: parameterName,
  /** Read out on the call, so the responder knows what they are being asked for. */
  description: z.string().min(1).max(200),
  required: z.boolean().default(true),
};

/**
 * A value the responder can supply out loud. The type is the guardrail: speech arrives as words, so
 * anything the definition did not declare, or declared differently, is refused before it can be
 * substituted into a request.
 */
export const actionParameter = z.discriminatedUnion("type", [
  z.object({
    ...sharedParameter,
    type: z.literal("string"),
    maxLength: z.number().int().min(1).max(200).default(80),
  }),
  z.object({
    ...sharedParameter,
    type: z.literal("number"),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.object({ ...sharedParameter, type: z.literal("boolean") }),
  z.object({
    ...sharedParameter,
    type: z.literal("enum"),
    options: z.array(z.string().min(1).max(60)).min(1).max(20),
  }),
]);

export type ActionParameter = z.infer<typeof actionParameter>;
export type ParameterValue = string | number | boolean;

export const serviceStateOperations = [
  "kill_switch_on",
  "kill_switch_off",
  "rollback",
] as const;

export type ServiceStateOperation = (typeof serviceStateOperations)[number];

/** State Ringbolt owns itself, which is what makes an action demonstrable without a third party. */
const serviceStateTarget = z.object({
  kind: z.literal("service_state"),
  operation: z.enum(serviceStateOperations),
});

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/**
 * Headers whose value is a credential. A definition may reference a binding for one of these but
 * may not carry the value: the definitions table is readable through the configuration API and
 * every run is written to the audit trail, and a secret in either is a secret in both.
 */
const credentialHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

const headerValue = z.union([
  z.string().min(1).max(200),
  z.object({ fromSecret: z.string().regex(secretBindingPattern) }),
]);

export type HeaderValue = z.infer<typeof headerValue>;

const httpTarget = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1).max(500),
  headers: z
    .record(z.string().regex(/^[a-zA-Z0-9-]{1,40}$/), headerValue)
    .default({}),
  body: z.record(z.string(), jsonValue).optional(),
  timeoutMs: z.number().int().min(500).max(20_000).default(5_000),
  /**
   * Whether running it twice is the same as running it once. A request that never came back may
   * have been carried out anyway, so only an action that says this may be retried at all.
   */
  idempotent: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(3).default(1),
  /** Which status codes count as done. Anything 2xx when this is left out. */
  expectStatus: z
    .array(z.number().int().min(200).max(599))
    .min(1)
    .max(5)
    .optional(),
});

/**
 * How to check afterwards that the action took effect. It is a read of the system that was changed,
 * not a reading of our own record of having changed it, which is the only version worth having.
 */
const httpVerify = z.object({
  url: z.string().min(1).max(500),
  /** Where to look in the JSON that comes back, as a path of keys. */
  jsonPath: z.array(z.string().min(1).max(60)).min(1).max(6),
  equals: z.union([z.string().max(200), z.number(), z.boolean()]),
  attempts: z.number().int().min(1).max(5).default(3),
  delayMs: z.number().int().min(0).max(10_000).default(1_000),
  timeoutMs: z.number().int().min(500).max(20_000).default(5_000),
});

export type HttpVerify = z.infer<typeof httpVerify>;

const definitionShape = z.object({
  label: z.string().min(1).max(80),
  /** Spoken to the responder, so it is a sentence rather than a description of a function. */
  spokenDescription: z.string().min(1).max(300),
  confirmationPhrase: z.string().min(3).max(80).nullable().default(null),
  minConfidence: z.number().min(0).max(1).nullable().default(null),
  parameters: z.array(actionParameter).max(6).default([]),
  target: z.discriminatedUnion("kind", [serviceStateTarget, httpTarget]),
  verify: httpVerify.nullable().default(null),
});

type DefinitionShape = z.infer<typeof definitionShape>;

export const actionDefinitionInput = definitionShape.superRefine(
  (definition, ctx) => {
    for (const problem of definitionProblems(definition)) {
      ctx.addIssue({ code: "custom", message: problem, path: [] });
    }
  },
);

export type ActionDefinitionInput = z.infer<typeof actionDefinitionInput>;

export type ActionDefinition = ActionDefinitionInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type ActionTarget = ActionDefinition["target"];
export type HttpTarget = Extract<ActionTarget, { kind: "http" }>;

/**
 * Everything that has to be true of a definition as a whole rather than field by field. Each one is
 * refused when the definition is stored, at a keyboard, rather than at three in the morning when a
 * responder has just authorized it.
 */
function definitionProblems(definition: DefinitionShape): string[] {
  const problems: string[] = [];
  const names = definition.parameters.map((parameter) => parameter.name);
  if (new Set(names).size !== names.length) {
    problems.push("two parameters have the same name");
  }
  for (const parameter of definition.parameters) {
    if (
      parameter.type === "number" &&
      parameter.min !== undefined &&
      parameter.max !== undefined &&
      parameter.min > parameter.max
    ) {
      problems.push(`${parameter.name} has a minimum above its maximum`);
    }
  }

  const required = new Set(
    definition.parameters.filter((one) => one.required).map((one) => one.name),
  );
  problems.push(...targetProblems(definition, required));

  if (definition.verify !== null) {
    if (definition.target.kind !== "http") {
      problems.push(
        "only an http action declares a check, because a service_state action is always read back",
      );
    } else {
      problems.push(
        ...urlProblems(definition.verify.url, required, "the check's url"),
      );
    }
  }

  return problems;
}

function targetProblems(
  definition: DefinitionShape,
  required: ReadonlySet<string>,
): string[] {
  const target = definition.target;
  if (target.kind !== "http") return [];

  const problems = urlProblems(target.url, required, "the url");
  for (const [name, value] of Object.entries(target.headers)) {
    if (
      credentialHeaders.has(name.toLowerCase()) &&
      typeof value === "string"
    ) {
      problems.push(
        `${name} carries a credential, so it has to name a binding as {"fromSecret": "RUNBOOK_SECRET_..."} rather than hold the value`,
      );
    }
  }

  if (target.body !== undefined) {
    const body = JSON.stringify(target.body);
    if (body.length > 4_000) problems.push("the body is too long");
    problems.push(...undeclared(body, required, "the body"));
  }

  if (target.maxAttempts > 1 && !target.idempotent) {
    problems.push(
      "an action that is not idempotent cannot be retried, because a request that timed out may have been carried out anyway",
    );
  }

  return problems;
}

function urlProblems(
  url: string,
  required: ReadonlySet<string>,
  what: string,
): string[] {
  const problems = undeclared(url, required, what);
  const structural = actionUrlProblem(url);
  if (structural !== null) problems.push(`${what} ${structural}`);
  return problems;
}

function undeclared(
  template: string,
  required: ReadonlySet<string>,
  what: string,
): string[] {
  const problems: string[] = [];
  for (const match of template.matchAll(placeholder)) {
    const name = match[1] ?? "";
    if (!required.has(name)) {
      problems.push(
        `${what} uses {${name}}, which is not a required parameter of this action`,
      );
    }
  }
  return problems;
}

/** A probe that cannot change how a url parses, so the shape of the template is what gets checked. */
const PLACEHOLDER_PROBE = "placeholder";

/**
 * Why this url may not be called, or null when it may be.
 *
 * Ringbolt makes this request itself, from inside its own network, on the say-so of a row in a
 * database. That is the shape of every request-forgery bug, so the target is confined to a public
 * name on the ordinary HTTPS port: no other scheme, no address literal, no host that only exists
 * inside a private network, and no credentials smuggled into the url.
 *
 * What this cannot do is stop a public name that resolves to a private address, since a Worker
 * cannot pin the address its fetch resolves to. The host allowlist in the deployment configuration
 * is the answer to that one, and it is checked again when the action runs.
 */
export function actionUrlProblem(template: string): string | null {
  let url: URL;
  try {
    url = new URL(template.replace(placeholder, PLACEHOLDER_PROBE));
  } catch {
    return "is not a url";
  }

  if (url.protocol !== "https:") return "has to be https";
  if (url.username !== "" || url.password !== "")
    return "must not carry credentials in the url";
  if (url.port !== "" && url.port !== "443")
    return "has to use the ordinary https port";
  return hostProblem(url.hostname);
}

/** The host a url template names, or null when it does not name one that can be called. */
export function actionHost(template: string): string | null {
  if (actionUrlProblem(template) !== null) return null;
  return canonicalHost(
    new URL(template.replace(placeholder, PLACEHOLDER_PROBE)).hostname,
  );
}

/**
 * A host name as everything here reads it: lower case, and without the DNS root dot.
 *
 * The trailing dot is the reason this exists rather than a bare toLowerCase. A name written
 * `localhost.` or `metadata.google.internal.` resolves to exactly what its bare form resolves to,
 * but the dot on the end satisfied the public-name test on its own and moved the end of the string
 * past every private-name match below, so both walked through a guard whose whole purpose is to
 * refuse them. Every hostile case in the suite was written bare, so nothing could see it.
 *
 * It is also the normalisation the allowlist has to use. The allowlist is compared by exact string,
 * so a name canonicalised one way here and another way in the configuration is a host refused for a
 * reason nobody reading either of them could work out.
 */
export function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function hostProblem(hostname: string): string | null {
  const host = canonicalHost(hostname);
  if (host.startsWith("[")) return "must not be an address literal";
  if (/^[0-9.]+$/.test(host)) return "must not be an address literal";
  if (!host.includes(".") || host.length > 253)
    return "has to be a public host name";
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host))
    return "must not be a private host name";
  return null;
}

/** The spoken half of a definition, which is all the caller needs to read an action out. */
export function spokenLines(definition: {
  id: string;
  spokenDescription: string;
  confirmationPhrase: string | null;
  parameters: readonly ActionParameter[];
}): string {
  const asks = definition.parameters
    .map((parameter) => `${parameter.name} (${parameter.description})`)
    .join(", ");
  const needed = asks === "" ? "" : ` Ask them for: ${asks}.`;
  const confirmation =
    definition.confirmationPhrase === null
      ? ""
      : ` Before doing this one, ask them to say the exact words "${definition.confirmationPhrase}" and record what they said.`;
  return `- ${definition.id}: ${definition.spokenDescription}.${needed}${confirmation}`;
}
