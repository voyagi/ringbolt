import { describe, expect, it } from "vitest";
import { CallNotAttemptedError } from "./port.js";
import { SchemaNotSupportedError, resultSchemaProblem } from "./schema.js";

/** Every feature CALL-E's contract lists as supported, in one schema. */
const everythingTheyAccept = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: {
      type: "string",
      enum: ["run_action", "hold"],
      description: "What the responder decided.",
    },
    minutes: { type: "number", description: "How long to wait." },
    values: {
      type: "object",
      additionalProperties: false,
      properties: {
        release: { type: "string", description: "Which release." },
      },
    },
    reasons: {
      type: "array",
      items: { type: "string" },
      description: "Why, in their words.",
    },
  },
};

describe("resultSchemaProblem", () => {
  it("accepts everything CALL-E documents as supported", () => {
    expect(resultSchemaProblem(everythingTheyAccept)).toBeNull();
  });

  /**
   * The shape that was refused on 2026-09-08, before the first call after the top-up could dial.
   * It had been the decision contract since 2026-08-22. This is the positive control for the whole
   * check: if it stops naming this one, the check is not doing the job it was written for.
   */
  it("refuses the shape CALL-E refused on 2026-09-08, and names the field", () => {
    const problem = resultSchemaProblem({
      type: "object",
      properties: {
        decision: { type: "string" },
        action_parameters: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    });

    expect(problem).toContain("result_schema.action_parameters");
    expect(problem).toContain("additionalProperties: false");
  });

  it("refuses additionalProperties: true, which their contract names", () => {
    expect(
      resultSchemaProblem({ type: "object", additionalProperties: true }),
    ).toContain("additionalProperties: false");
  });

  /** The case a participant reported to them on 2026-08-17: `{"type":["string","null"]}`. */
  it("refuses a type given as a list", () => {
    expect(
      resultSchemaProblem({
        type: "object",
        properties: { note: { type: ["string", "null"] } },
      }),
    ).toContain("result_schema.note gives type as a list");
  });

  it.each(["$ref", "oneOf", "anyOf", "allOf", "format"])(
    "refuses %s, which their contract names",
    (keyword) => {
      const problem = resultSchemaProblem({
        type: "object",
        properties: { field: { type: "string", [keyword]: "anything" } },
      });
      expect(problem).toBe(
        `result_schema.field uses ${keyword}, which CALL-E does not support`,
      );
    },
  );

  it("refuses a list of item schemas, since only a simple array is supported", () => {
    expect(
      resultSchemaProblem({
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      }),
    ).toContain("result_schema.pair.items is a list");
  });

  it("looks inside nested objects and array items, and reports the path", () => {
    expect(
      resultSchemaProblem({
        type: "object",
        properties: {
          outer: {
            type: "object",
            properties: {
              inner: {
                type: "array",
                items: { type: "string", format: "date" },
              },
            },
          },
        },
      }),
    ).toBe(
      "result_schema.outer.inner.items uses format, which CALL-E does not support",
    );
  });

  it("names the first problem it meets rather than every problem", () => {
    const problem = resultSchemaProblem({
      type: "object",
      additionalProperties: true,
      properties: { a: { type: ["string", "null"] } },
    });
    expect(problem).toContain("result_schema allows properties");
    expect(problem).not.toContain("result_schema.a");
  });

  it.each([null, "object", 7, [{ type: "object" }]])(
    "refuses %j, which is not a schema object at all",
    (value) => {
      expect(resultSchemaProblem(value)).toBe(
        "result_schema has to be a JSON Schema object",
      );
    },
  );

  it("refuses properties that are not an object", () => {
    expect(
      resultSchemaProblem({ type: "object", properties: ["decision"] }),
    ).toBe("result_schema.properties has to be an object");
  });

  it("accepts a schema with no properties and no items", () => {
    expect(resultSchemaProblem({ type: "object" })).toBeNull();
  });

  /** A field that says nothing about its type is one they accept: only a LIST of types is not. */
  it("accepts a field that gives no type at all", () => {
    expect(
      resultSchemaProblem({
        type: "object",
        properties: { note: { description: "whatever they said" } },
      }),
    ).toBeNull();
  });

  it("still checks the properties after the items were fine", () => {
    expect(
      resultSchemaProblem({
        type: "array",
        items: { type: "string" },
        properties: { stray: { type: ["string", "null"] } },
      }),
    ).toContain("result_schema.stray gives type as a list");
  });
});

describe("SchemaNotSupportedError", () => {
  /** The orchestrator reads this type to know no call task exists and nothing was billed. */
  it("is a refusal raised before anything was sent", () => {
    const error = new SchemaNotSupportedError(
      "result_schema.action_parameters allows properties it does not name",
    );
    expect(error).toBeInstanceOf(CallNotAttemptedError);
    expect(error.name).toBe("SchemaNotSupportedError");
    expect(error.message).toBe(
      "result_schema.action_parameters allows properties it does not name, so no call was placed",
    );
  });
});
