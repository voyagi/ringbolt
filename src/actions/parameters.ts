import type { ActionParameter, ParameterValue } from "./definition.js";

export type ParameterOutcome =
  | { ok: true; values: Record<string, ParameterValue> }
  | { ok: false; problem: string };

const AFFIRMATIVE = new Set(["true", "yes", "on"]);
const NEGATIVE = new Set(["false", "no", "off"]);

/**
 * Turns what the responder said into the values an action declared it takes, or says why it cannot.
 *
 * Everything arrives as words. A number spoken over a telephone comes back as a string, sometimes
 * with a currency symbol or a stray full stop attached, and "yeah" is a boolean to a person and
 * nothing at all to a program. So each value is checked against the type its parameter declared and
 * refused if it does not fit, rather than coerced into whatever the request happened to accept.
 */
export function readParameters(
  declared: readonly ActionParameter[],
  spoken: unknown,
): ParameterOutcome {
  const given = asRecord(spoken);
  if (given === null) {
    return { ok: false, problem: "the values came back in an unusable shape" };
  }

  const known = new Set(declared.map((parameter) => parameter.name));
  const unknown = Object.keys(given).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: `${unknown.join(", ")} is not a parameter of this action`,
    };
  }

  const values: Record<string, ParameterValue> = {};
  for (const parameter of declared) {
    const raw = given[parameter.name];
    if (raw === undefined || raw === null || raw === "") {
      if (parameter.required) {
        return {
          ok: false,
          problem: `${parameter.name} is needed and was not given`,
        };
      }
      continue;
    }

    const read = readOne(parameter, raw);
    if (read === null) {
      return {
        ok: false,
        problem: `${parameter.name} does not fit what this action accepts: ${describe(parameter)}`,
      };
    }
    values[parameter.name] = read;
  }

  return { ok: true, values };
}

function readOne(
  parameter: ActionParameter,
  raw: unknown,
): ParameterValue | null {
  switch (parameter.type) {
    case "string": {
      if (typeof raw !== "string") return null;
      const value = raw.trim();
      return value === "" || value.length > parameter.maxLength ? null : value;
    }
    case "number": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) return null;
      if (parameter.min !== undefined && value < parameter.min) return null;
      if (parameter.max !== undefined && value > parameter.max) return null;
      return value;
    }
    case "boolean":
      return readBoolean(raw);
    case "enum": {
      if (typeof raw !== "string") return null;
      const spoken = raw.trim().toLowerCase();
      return (
        parameter.options.find((option) => option.toLowerCase() === spoken) ??
        null
      );
    }
  }
}

function readBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (AFFIRMATIVE.has(value)) return true;
  if (NEGATIVE.has(value)) return false;
  return null;
}

/** What the parameter would have accepted, for the refusal a human reads afterwards. */
function describe(parameter: ActionParameter): string {
  switch (parameter.type) {
    case "string":
      return `text up to ${parameter.maxLength} characters`;
    case "number":
      return `a number${parameter.min === undefined ? "" : ` from ${parameter.min}`}${parameter.max === undefined ? "" : ` up to ${parameter.max}`}`;
    case "boolean":
      return "yes or no";
    case "enum":
      return `one of ${parameter.options.join(", ")}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
