import { describe, expect, it } from "vitest";
import type { ActionParameter } from "./definition.js";
import { readParameters } from "./parameters.js";

const release: ActionParameter = {
  name: "release",
  description: "which release to go back to",
  type: "string",
  required: true,
  maxLength: 20,
};

const instances: ActionParameter = {
  name: "instances",
  description: "how many to run",
  type: "number",
  required: true,
  min: 1,
  max: 10,
};

const region: ActionParameter = {
  name: "region",
  description: "which region",
  type: "enum",
  required: true,
  options: ["eu-west", "us-east"],
};

const drain: ActionParameter = {
  name: "drain",
  description: "whether to drain first",
  type: "boolean",
  required: true,
};

describe("reading back what the responder said", () => {
  it("takes a string and trims what speech to text leaves on it", () => {
    expect(readParameters([release], { release: "  2026-08-19-a " })).toEqual({
      ok: true,
      values: { release: "2026-08-19-a" },
    });
  });

  it("refuses a string longer than the action declared", () => {
    const outcome = readParameters([release], { release: "x".repeat(21) });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok || outcome.problem).toContain("20 characters");
  });

  /** A number over a telephone arrives as words, so the digits have to survive being a string. */
  it("takes a number written as text and holds it to its range", () => {
    expect(readParameters([instances], { instances: "6" })).toEqual({
      ok: true,
      values: { instances: 6 },
    });
    expect(readParameters([instances], { instances: 40 })).toMatchObject({
      ok: false,
    });
    expect(
      readParameters([instances], { instances: "about six" }),
    ).toMatchObject({ ok: false });
  });

  it("takes yes and no as a boolean and refuses a maybe", () => {
    expect(readParameters([drain], { drain: "yes" })).toEqual({
      ok: true,
      values: { drain: true },
    });
    expect(readParameters([drain], { drain: "No" })).toEqual({
      ok: true,
      values: { drain: false },
    });
    expect(readParameters([drain], { drain: "possibly" })).toMatchObject({
      ok: false,
    });
  });

  it("matches an option however it was capitalised, and refuses one that is not offered", () => {
    expect(readParameters([region], { region: "EU-West" })).toEqual({
      ok: true,
      values: { region: "eu-west" },
    });
    expect(readParameters([region], { region: "ap-south" })).toMatchObject({
      ok: false,
    });
  });

  /**
   * The values are substituted into a request, so a name the action never declared is a field
   * somebody else chose. It is refused rather than dropped, because the responder said something
   * and quietly ignoring it is how a decision turns into a different one.
   */
  it("refuses a value the action never asked for", () => {
    const outcome = readParameters([release], {
      release: "2026-08-19-a",
      force: "true",
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok || outcome.problem).toContain("force");
  });

  it("refuses a required value that was not given, and allows an optional one to be missing", () => {
    expect(readParameters([release], {})).toMatchObject({ ok: false });
    expect(readParameters([{ ...release, required: false }], {})).toEqual({
      ok: true,
      values: {},
    });
    expect(
      readParameters([{ ...release, required: false }], { release: "" }),
    ).toEqual({ ok: true, values: {} });
  });

  it("treats nothing at all as nothing given", () => {
    expect(readParameters([], undefined)).toEqual({ ok: true, values: {} });
    expect(readParameters([], ["not", "an", "object"])).toMatchObject({
      ok: false,
    });
  });
});
