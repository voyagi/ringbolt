import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetTables } from "./support/reset.js";

const ADMIN_TOKEN = "a-long-enough-dummy-admin-token";
const OURS = "https://ringbolt.test";
const THEIRS = "https://someone-elses-page.test";

/**
 * The suite runs with `RINGBOLT_ENV=development` and no `ADMIN_TOKEN`, which is `open` mode: the
 * exact configuration every fresh clone's `npm run dev` lands in, and the one these routes were
 * forgeable from.
 */
async function admin(
  path: string,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<Response> {
  return SELF.fetch(`${OURS}${path}`, { method, headers });
}

async function whyRefused(response: Response): Promise<string> {
  const body = (await response.json()) as { because?: string };
  return body.because ?? "";
}

describe("open mode and requests from another website", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  afterEach(() => {
    delete env.ADMIN_TOKEN;
  });

  /**
   * The whole point. A page the developer has open in the same browser can post a form at the local
   * Worker, and the browser sends it without asking anybody. Four of the routes behind this guard
   * read no body at all, so a hidden form with no script was enough.
   */
  it.each([
    "/api/demo/break",
    "/api/demo/repair",
    "/api/demo/seed",
    "/api/config/contacts/con_whatever/erase",
  ])("refuses a cross-site form post to %s", async (path) => {
    const response = await admin(path, {
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(403);
    expect(await whyRefused(response)).toContain("cross-site");
  });

  /**
   * A body labelled `text/plain` skips the browser's preflight while still parsing as JSON, because
   * the body reader never looks at the content type. Closing that by content type would have broken
   * the intake route, so the origin is what is checked instead, whatever the body claims to be.
   */
  it("refuses a cross-site post whose body poses as plain text", async () => {
    const response = await SELF.fetch(`${OURS}/api/config/contacts`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      body: JSON.stringify({ name: "Mallory", phone: "+310000000000" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuses a post whose Origin is another site", async () => {
    const response = await admin("/api/demo/repair", { origin: THEIRS });
    expect(response.status).toBe(403);
    expect(await whyRefused(response)).toContain(THEIRS);
  });

  /** `same-site` is a different host on the same registrable domain, which is still not this one. */
  it("refuses a post from a sibling host on the same site", async () => {
    expect(
      (await admin("/api/demo/repair", { "sec-fetch-site": "same-site" }))
        .status,
    ).toBe(403);
  });

  it("lets the dashboard's own requests through", async () => {
    expect(
      (
        await admin(
          "/api/config/actions",
          { "sec-fetch-site": "same-origin", origin: OURS },
          "GET",
        )
      ).status,
    ).toBe(200);
  });

  /**
   * A direct navigation carries `none`. It is not a cross-site request and must not be refused as
   * one, or the developer cannot open the dashboard by typing its address.
   */
  it("lets a typed-in address through", async () => {
    expect(
      (await admin("/api/config/actions", { "sec-fetch-site": "none" }, "GET"))
        .status,
    ).toBe(200);
  });

  /**
   * Absent headers stay allowed, deliberately. curl sends neither, the README's own commands are
   * curl, and serving them with no token is the only reason `open` mode exists. This guard refuses
   * what it can show came from elsewhere rather than admitting only what it can show did not.
   */
  it("lets a request with no origin headers through, which is curl", async () => {
    expect((await admin("/api/config/actions", {}, "GET")).status).toBe(200);
  });

  /**
   * The token path is untouched. It was never forgeable: setting `Authorization` cross-site is not
   * a simple request, so the browser preflights it and this Worker answers no preflight
   * permissively. A token holder posting from anywhere therefore still works, which is what a
   * monitor or a script on another host needs.
   */
  it("does not apply the origin check once a token is set", async () => {
    env.ADMIN_TOKEN = ADMIN_TOKEN;
    const response = await admin(
      "/api/config/actions",
      {
        "sec-fetch-site": "cross-site",
        origin: THEIRS,
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      "GET",
    );
    expect(response.status).toBe(200);
  });

  /** And a deployment with no token still refuses outright, which is a different answer. */
  it("still answers 503 rather than 403 when the environment is not development", async () => {
    const wasEnv = env.RINGBOLT_ENV;
    env.RINGBOLT_ENV = "production";
    try {
      const response = await admin("/api/config/actions", {}, "GET");
      expect(response.status).toBe(503);
    } finally {
      env.RINGBOLT_ENV = wasEnv;
    }
  });
});
