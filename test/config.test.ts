import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import type { Incident } from "../src/domain/incident.js";
import {
  ConfigurationError,
  type LiveConfig,
  allowedActionHosts,
  allowedLiveNumbers,
  readConfig,
} from "../src/worker/env.js";
import { buildPlacer, immediateScheduler } from "../src/worker/wiring.js";

const base = {
  RINGBOLT_ENV: "production",
  CALLE_MODE: "fake",
  PUBLIC_BASE_URL: "https://ringbolt.example.com",
  INTAKE_TOKEN: "a-long-enough-intake-token",
};

const live = {
  ...base,
  CALLE_MODE: "live",
  CALLE_API_KEY: "test-key-configuration",
  DEMO_PHONE: "+31612345678",
};

/**
 * The suite cannot reach a telephone. This is not a style rule, it is the thing that failed: on
 * 2026-08-22 the suite was run while `.dev.vars` said `CALLE_MODE=live`, and it obediently built
 * the real client from the real key and rang a real number three times. `vitest.config.ts` now
 * pins the mode, the key and the number, and these assertions are what stop that pinning being
 * quietly removed by somebody who does not know why it is there.
 */
describe("the test environment itself", () => {
  it("cannot be in live mode however the machine is configured", () => {
    expect(readConfig(env).CALLE_MODE).toBe("fake");
  });

  it("builds the stand-in rather than a real telephone", () => {
    const placer = buildPlacer(env, readConfig(env), {
      scheduler: immediateScheduler,
    });
    expect(placer.kind).toBe("fake");
  });

  /**
   * Defence in depth, because the point of the second and third layers is that they hold when the
   * first one has been broken. An unassigned country code cannot be routed by any network.
   */
  it("carries no real credential and no reachable number", () => {
    const ambient = env as unknown as Record<string, string>;
    expect(ambient["CALLE_API_KEY"]).not.toMatch(/^iams_/);
    expect(ambient["DEMO_PHONE"]).toBe("+99900000000");
  });

  /**
   * The same idea one layer out. A runbook action can reach any host somebody stores in a table,
   * and a test can store one, so the suite pins the only name any action it defines may call. That
   * name does not resolve, so the worst a stored action can do here is fail to connect.
   */
  it("can only point a runbook action at a name that does not exist", () => {
    expect(allowedActionHosts(readConfig(env))).toEqual([
      "actions.ringbolt.test",
    ]);
  });
});

describe("reading the configuration", () => {
  it("accepts the stand-in", () => {
    expect(readConfig(base).CALLE_MODE).toBe("fake");
  });

  it("accepts live mode once there is a key and a number", () => {
    expect(readConfig(live).CALLE_MODE).toBe("live");
  });

  /**
   * Three documents used to tell an operator to switch this on before the adapter existed, and the
   * switch was accepted: the health check reported healthy while every intake and every webhook
   * returned a five hundred at the moment a phone was supposed to ring. What is refused here is
   * what makes the health check right, so each half of a working telephone is required by name.
   */
  it("refuses live mode with no api key", () => {
    const { CALLE_API_KEY: _absent, ...withoutKey } = live;
    expect(() => readConfig(withoutKey)).toThrow(ConfigurationError);
  });

  it("refuses live mode with no number to dial", () => {
    const { DEMO_PHONE: _absent, ...withoutPhone } = live;
    expect(() => readConfig(withoutPhone)).toThrow(ConfigurationError);
  });

  /** The placeholder the stand-in carries. It must never be able to become a real call. */
  it("refuses a number that is not a real one", () => {
    expect(() => readConfig({ ...live, DEMO_PHONE: "+00000000000" })).toThrow(
      ConfigurationError,
    );
  });

  /**
   * The one switch that takes the whole build off the telephone, whatever any environment says.
   * The allowance is twenty calls and cannot be topped up, so it is worth being able to stop.
   */
  it("refuses live mode when the build has live calling switched off", () => {
    expect(() => readConfig(live, { liveAvailable: false })).toThrow(
      ConfigurationError,
    );
    expect(readConfig(live, { liveAvailable: true }).CALLE_MODE).toBe("live");
  });

  /**
   * `.env.example` ships every fill-in-later value blank and the README says to copy it, so a
   * blank has to mean absent. Otherwise the first thing a new copy of the file does is fail on a
   * token nobody had set yet.
   */
  it("reads a blank value as one that was never set", () => {
    expect(
      readConfig({ ...base, INTAKE_TOKEN: "" }).INTAKE_TOKEN,
    ).toBeUndefined();
    expect(() => readConfig({ ...live, CALLE_API_KEY: "" })).toThrow(
      ConfigurationError,
    );
  });

  /**
   * The rotation can name any contact anybody added, so the numbers a live build may dial are
   * configuration rather than data. The configured number is always on the list because it is what
   * the fallback responder uses when no rotation exists.
   */
  it("allows only the configured number until more are named", () => {
    expect(allowedLiveNumbers(readConfig(live) as LiveConfig)).toEqual([
      "+31612345678",
    ]);
  });

  it("keeps the configured number on the list even when it is left off", () => {
    const config = readConfig({
      ...live,
      LIVE_CALL_ALLOWLIST: "+31698765432",
    }) as LiveConfig;
    expect(allowedLiveNumbers(config)).toEqual([
      "+31698765432",
      "+31612345678",
    ]);
  });

  it("refuses an allowlist entry that is not a phone number", () => {
    expect(() =>
      readConfig({ ...live, LIVE_CALL_ALLOWLIST: "+31698765432,not-a-number" }),
    ).toThrow(ConfigurationError);
  });

  it("refuses a stand-in scenario the stand-in cannot produce", () => {
    expect(() =>
      readConfig({ ...base, CALLE_FAKE_SCENARIO: "explodes" }),
    ).toThrow(ConfigurationError);
    expect(readConfig(base).CALLE_FAKE_SCENARIO).toBe("answers");
  });

  it("refuses an admin token too short to be worth having", () => {
    expect(() => readConfig({ ...base, ADMIN_TOKEN: "short" })).toThrow(
      ConfigurationError,
    );
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
    wakeReason: null,
    callAttempts: 1,
    rotationPosition: 0,
    contactId: null,
    callStartedAt: "2026-08-21T12:00:00.000Z",
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

  /**
   * Two of these columns cannot hold null, and a patch built by spreading an object can carry a key
   * whose value happens to be undefined. Writing that as null turns a routine update into a
   * constraint failure part way through an incident, which on this product is a phone call that
   * never gets made. Present-but-undefined therefore means the same as absent.
   */
  it("skips a field that is present but undefined rather than writing null", async () => {
    const repo = new Repo(env.DB);
    await env.DB.prepare(`DELETE FROM incidents WHERE id = ?1`)
      .bind(incident.id)
      .run();
    await repo.createIncident(incident);

    await repo.updateIncident(
      incident.id,
      { callAttempts: undefined, outcome: "left alone" },
      "2026-08-21T12:02:00.000Z",
    );

    const after = await repo.getIncident(incident.id);
    expect(after?.callAttempts).toBe(1);
    expect(after?.outcome).toBe("left alone");
  });
});
