import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import {
  ADMIN_FAILURES,
  INTAKE_PER_SENDER,
  countAgainst,
  intakeBucket,
} from "../src/worker/limits.js";
import { resetTables } from "./support/reset.js";

const ADMIN_TOKEN = "a-long-enough-admin-token";
const INTAKE_TOKEN = "a-long-enough-intake-token";

const alert = {
  service: "checkout",
  title: "Payment errors above 20 percent",
  severity: "critical",
};

/** One sender, named, so a test can flood as one address and check as another. */
function intake(from: string, title = alert.title): Promise<Response> {
  return SELF.fetch(`https://ringbolt.test/intake/${INTAKE_TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": from,
    },
    body: JSON.stringify({ ...alert, title }),
  });
}

describe("counting requests against a window", () => {
  let repo: Repo;

  beforeEach(async () => {
    await resetTables(env.DB);
    repo = new Repo(env.DB);
  });

  it("allows up to the limit and refuses the one after it", async () => {
    const limit = { limit: 3, windowMs: 60_000 };
    const now = new Date("2026-08-25T12:00:00.000Z");

    for (let n = 0; n < 3; n += 1) {
      expect((await countAgainst(repo, "b", limit, now)).allowed).toBe(true);
    }
    expect((await countAgainst(repo, "b", limit, now)).allowed).toBe(false);
  });

  it("keeps one bucket's flood out of another's allowance", async () => {
    const limit = { limit: 1, windowMs: 60_000 };
    const now = new Date("2026-08-25T12:00:00.000Z");

    await countAgainst(repo, "one", limit, now);
    await countAgainst(repo, "one", limit, now);

    expect((await countAgainst(repo, "two", limit, now)).allowed).toBe(true);
  });

  it("starts again in the next window", async () => {
    const limit = { limit: 1, windowMs: 60_000 };
    const first = new Date("2026-08-25T12:00:30.000Z");
    const next = new Date("2026-08-25T12:01:05.000Z");

    await countAgainst(repo, "b", limit, first);
    expect((await countAgainst(repo, "b", limit, first)).allowed).toBe(false);
    expect((await countAgainst(repo, "b", limit, next)).allowed).toBe(true);
  });

  /**
   * A caller that keeps going while being refused has to keep being refused. Leaving the refused
   * requests uncounted would let a flood slide back under the limit by flooding harder.
   */
  it("counts a request it is refusing", async () => {
    const limit = { limit: 1, windowMs: 60_000 };
    const now = new Date("2026-08-25T12:00:00.000Z");

    await countAgainst(repo, "b", limit, now);
    await countAgainst(repo, "b", limit, now);
    expect((await countAgainst(repo, "b", limit, now)).allowed).toBe(false);
  });

  it("says how long the window has left, in whole seconds and never zero", async () => {
    const limit = { limit: 1, windowMs: 60_000 };
    const verdict = await countAgainst(
      repo,
      "b",
      limit,
      new Date("2026-08-25T12:00:59.900Z"),
    );
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("keeps the windows bounded rather than growing a row per request", async () => {
    const limit = { limit: 100, windowMs: 60_000 };
    const now = new Date("2026-08-25T12:00:00.000Z");
    for (let n = 0; n < 12; n += 1) {
      await countAgainst(repo, "b", limit, now);
    }

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM rate_windows`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("prunes windows that are long over", async () => {
    await countAgainst(
      repo,
      "b",
      { limit: 1, windowMs: 60_000 },
      new Date("2026-08-25T12:00:00.000Z"),
    );
    const removed = await repo.pruneRateWindows("2026-08-25T13:00:00.000Z");
    expect(removed).toBe(1);
  });
});

/**
 * Spends a sender's whole allowance without sending the alerts.
 *
 * Sixty real requests would each open an incident and place a stand-in call, which is a minute of
 * work to prove a counter, and the stand-in's own timers outlive the test that started them. This
 * counts against the same bucket the endpoint counts against, named from the same function, so what
 * is being tested is the endpoint's wiring rather than the arithmetic that has its own tests above.
 */
async function burnAllowance(sender: string): Promise<void> {
  const repo = new Repo(env.DB);
  const now = new Date();
  for (let n = 0; n < INTAKE_PER_SENDER.limit; n += 1) {
    await countAgainst(repo, intakeBucket(sender), INTAKE_PER_SENDER, now);
  }
}

describe("the intake endpoint under a flood", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.INTAKE_TOKEN = INTAKE_TOKEN;
  });

  afterEach(() => {
    env.INTAKE_TOKEN = "";
  });

  it("takes an alert while the sender is inside its allowance", async () => {
    expect((await intake("203.0.113.7")).status).toBe(202);
  });

  it("refuses one sender past its allowance and tells it when to come back", async () => {
    await burnAllowance("203.0.113.7");

    const refused = await intake("203.0.113.7", "one alert too many");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  /**
   * The limiter's own bookkeeping is a database write, so a caller who has not named a real token
   * must not be able to cause one. Otherwise the thing protecting this endpoint is the cheapest way
   * to make it write.
   */
  it("writes nothing at all for a caller who does not know the token", async () => {
    const response = await SELF.fetch(
      "https://ringbolt.test/intake/not-the-token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
      },
    );
    expect(response.status).toBe(404);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM rate_windows`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  /**
   * A sender backing off and trying again has to get a fresh judgement. An incident opened for an
   * alert that was refused would answer the retry as a duplicate of itself, and the alert would
   * never ring anybody.
   */
  it("leaves no incident behind when it refuses one", async () => {
    await burnAllowance("203.0.113.9");
    expect((await intake("203.0.113.9")).status).toBe(429);

    expect(await new Repo(env.DB).listIncidents(500)).toEqual([]);
  });
});

describe("presenting the wrong administrator token", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterEach(() => {
    env.ADMIN_TOKEN = "";
  });

  function attempt(token: string, from = "203.0.113.5"): Promise<Response> {
    return SELF.fetch("https://ringbolt.test/api/config/contacts", {
      headers: {
        authorization: `Bearer ${token}`,
        "CF-Connecting-IP": from,
      },
    });
  }

  it("answers a spray with a refusal to keep trying", async () => {
    for (let n = 0; n < ADMIN_FAILURES.limit; n += 1) {
      expect((await attempt(`guess-${n}`)).status).toBe(401);
    }
    expect((await attempt("guess-again")).status).toBe(429);
  });

  /**
   * The dashboard polls every two seconds with a token that works. A limit counted on requests
   * rather than on failures would lock out the person who is doing everything right.
   */
  it("never counts a request that carried the right token", async () => {
    for (let n = 0; n < ADMIN_FAILURES.limit + 5; n += 1) {
      expect((await attempt(ADMIN_TOKEN)).status).toBe(200);
    }

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM rate_windows`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("does not let one address's spray lock out another", async () => {
    for (let n = 0; n < ADMIN_FAILURES.limit + 1; n += 1) {
      await attempt(`guess-${n}`, "203.0.113.5");
    }
    expect((await attempt("wrong", "203.0.113.6")).status).toBe(401);
  });
});
