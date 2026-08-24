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

  /**
   * The edges, which is where a value that decides what happens to production goes wrong quietly.
   * Each of these was a mutant that survived the suite before it was written: the bound could have
   * been off by one in either direction and every other test would still have passed.
   */
  it("accepts a value sitting exactly on each bound", () => {
    expect(
      readParameters([release], { release: "x".repeat(20) }),
    ).toMatchObject({ ok: true });
    expect(readParameters([instances], { instances: 1 })).toEqual({
      ok: true,
      values: { instances: 1 },
    });
    expect(readParameters([instances], { instances: 10 })).toEqual({
      ok: true,
      values: { instances: 10 },
    });
    expect(readParameters([instances], { instances: 0 })).toMatchObject({
      ok: false,
    });
    expect(readParameters([instances], { instances: 11 })).toMatchObject({
      ok: false,
    });
  });

  /** Speech to text pads what it hands back, and the padding is not part of what was said. */
  it("trims before deciding, on every type that reads words", () => {
    expect(readParameters([drain], { drain: "  yes  " })).toEqual({
      ok: true,
      values: { drain: true },
    });
    expect(readParameters([region], { region: "  us-east " })).toEqual({
      ok: true,
      values: { region: "us-east" },
    });
    expect(readParameters([instances], { instances: " 6 " })).toEqual({
      ok: true,
      values: { instances: 6 },
    });
    expect(readParameters([release], { release: "   " })).toMatchObject({
      ok: false,
    });
  });

  it("takes every spelling of yes and no it claims to take", () => {
    for (const spoken of ["true", "yes", "on", "TRUE", "On"]) {
      expect(readParameters([drain], { drain: spoken })).toEqual({
        ok: true,
        values: { drain: true },
      });
    }
    for (const spoken of ["false", "no", "off", "OFF"]) {
      expect(readParameters([drain], { drain: spoken })).toEqual({
        ok: true,
        values: { drain: false },
      });
    }
    expect(readParameters([drain], { drain: true })).toEqual({
      ok: true,
      values: { drain: true },
    });
  });

  /**
   * The structured result is somebody else's JSON, so a value can arrive as any type at all. A
   * parameter declared as text takes text; a number where text was declared is a refusal rather
   * than something quietly stringified into a production request.
   */
  it("refuses a value that is not even the right kind of thing", () => {
    expect(readParameters([release], { release: 12 })).toMatchObject({
      ok: false,
    });
    expect(readParameters([region], { region: 12 })).toMatchObject({
      ok: false,
    });
    expect(readParameters([drain], { drain: 12 })).toMatchObject({ ok: false });
  });

  it("treats nothing at all as nothing given", () => {
    expect(readParameters([], undefined)).toEqual({ ok: true, values: {} });
    expect(readParameters([], ["not", "an", "object"])).toMatchObject({
      ok: false,
    });
  });
});
