import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import type { Incident } from "../src/domain/incident.js";
import { ConfigurationError, readConfig } from "../src/worker/env.js";

const base = {
  RINGBOLT_ENV: "production",
  CALLE_MODE: "fake",
  PUBLIC_BASE_URL: "https://ringbolt.example.com",
  INTAKE_TOKEN: "a-long-enough-intake-token",
};

describe("reading the configuration", () => {
  it("accepts the stand-in", () => {
    expect(readConfig(base).CALLE_MODE).toBe("fake");
  });

  /**
   * Three documents used to tell an operator to switch this on, and the switch was accepted: the
   * health check reported healthy while every intake and every webhook returned a five hundred at
   * the moment a phone was supposed to ring. Refusing it here is what makes the health check right.
   */
  it("refuses live mode while there is no adapter to honour it", () => {
    expect(() =>
      readConfig({ ...base, CALLE_MODE: "live", CALLE_API_KEY: "sk_real" }),
    ).toThrow(ConfigurationError);
  });

  it("names what is wrong rather than failing anonymously", () => {
    try {
      readConfig({ ...base, PUBLIC_BASE_URL: "not-a-url" });
      expect.unreachable("a bad base url should not be accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.join(" ")).toContain(
        "PUBLIC_BASE_URL",
      );
    }
  });
});

describe("patching an incident", () => {
  const incident: Incident = {
    id: "inc_patch",
    state: "calling",
    service: "checkout",
    title: "down",
    severity: "high",
    detail: null,
    fingerprint: "fp_patch",
    source: null,
    startedAt: null,
    links: [],
    offeredActions: ["kill_switch"],
    wakeAt: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    callId: "call_one",
    outcome: null,
  };

  /**
   * COALESCE reads an intentional null as "leave this alone", so clearing a column reported success
   * and wrote nothing. Nothing clears one today, which is why it would have stayed hidden until the
   * first caller that did, in the table that records what was authorized.
   */
  it("can clear a column, and leaves out what the patch does not mention", async () => {
    const repo = new Repo(env.DB);
    await env.DB.prepare(`DELETE FROM incidents WHERE id = ?1`)
      .bind(incident.id)
      .run();
    await repo.createIncident(incident);

    await repo.updateIncident(
      incident.id,
      { callId: null },
      "2026-08-21T12:01:00.000Z",
    );

    const cleared = await repo.getIncident(incident.id);
    expect(cleared?.callId).toBeNull();
    expect(cleared?.state).toBe("calling");
    expect(cleared?.offeredActions).toEqual(["kill_switch"]);
    expect(cleared?.updatedAt).toBe("2026-08-21T12:01:00.000Z");
  });
});
