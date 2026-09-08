import { CallNotAttemptedError } from "./port.js";

/**
 * The part of JSON Schema that CALL-E's extraction accepts, and the check that keeps this product
 * inside it.
 *
 * Their API contract (version 0.7.1) says what a `result_schema` may use: `type`, `properties`,
 * `required`, `enum`, nested `object` fields, simple `array.items`, `description`, and
 * `additionalProperties: false`. It names `$ref`, `oneOf`, `anyOf`, `allOf`, recursive schemas,
 * format validation and `additionalProperties: true` as unsupported, and refuses the whole create
 * for any of them with a bare "result_schema is not supported", the actual reason sitting under
 * `details.reason` in the response.
 *
 * On 2026-09-08 the first call after the top-up was refused that way, before it dialled. The
 * decision contract had described `action_parameters` as an object with any string keys since
 * 2026-08-22, which is an `additionalProperties` that is neither absent nor false. Nothing on this
 * side could see it: the suite proved the schema went out under the right key and never asked
 * whether it was one CALL-E would take. Both placers ask now, before anything is stored or sent.
 */

/** Keywords their contract lists as unsupported. `format` stands for "complex format validation". */
const REFUSED_KEYWORDS = ["$ref", "oneOf", "anyOf", "allOf", "format"] as const;

/**
 * Why CALL-E would refuse this schema, or null when every feature in it is one they document as
 * supported. Only what they list as unsupported is refused, and `additionalProperties` set to
 * anything but false, so a keyword they say nothing about passes: the job is to catch the refusal
 * that is known, not to be stricter than the vendor and refuse a call they would have made.
 */
export function resultSchemaProblem(
  schema: unknown,
  path = "result_schema",
): string | null {
  if (!isObject(schema)) return `${path} has to be a JSON Schema object`;

  for (const keyword of REFUSED_KEYWORDS) {
    if (keyword in schema) {
      return `${path} uses ${keyword}, which CALL-E does not support`;
    }
  }

  const type = schema["type"];
  if (type !== undefined && typeof type !== "string") {
    return `${path} gives type as a list, and CALL-E accepts one type per field`;
  }

  const additional = schema["additionalProperties"];
  if (additional !== undefined && additional !== false) {
    return `${path} allows properties it does not name, and CALL-E accepts only additionalProperties: false`;
  }

  const items = schema["items"];
  if (items !== undefined) {
    if (Array.isArray(items)) {
      return `${path}.items is a list, and CALL-E accepts one schema for every item`;
    }
    const problem = resultSchemaProblem(items, `${path}.items`);
    if (problem !== null) return problem;
  }

  const properties = schema["properties"];
  if (properties === undefined) return null;
  if (!isObject(properties)) return `${path}.properties has to be an object`;
  for (const [name, property] of Object.entries(properties)) {
    const problem = resultSchemaProblem(property, `${path}.${name}`);
    if (problem !== null) return problem;
  }

  return null;
}

/**
 * Raised before anything is stored or sent, by both placers. A schema CALL-E refuses makes no call
 * task and costs nothing, and the same is true of one refused here, so the incident closes as
 * `call_place_refused` with a message that names the field rather than "not supported".
 */
export class SchemaNotSupportedError extends CallNotAttemptedError {
  constructor(problem: string) {
    super(`${problem}, so no call was placed`);
    this.name = "SchemaNotSupportedError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
