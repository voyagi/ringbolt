import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ActionContext } from "../src/actions/context.js";
import {
  type HttpTarget,
  type HttpVerify,
  actionDefinitionInput,
} from "../src/actions/definition.js";
import { runHttp } from "../src/actions/http.js";
import { Repo } from "../src/db/repo.js";
import { jsonResponse, testActions } from "./support/actions.js";

type Sent = { url: string; method: string; headers: Headers; body: string };

/**
 * A transport that answers whatever the test wants and keeps what it was asked to send. Every case
 * here asserts on that record, because the point of most of them is what was NOT sent.
 */
function transport(answers: (sent: Sent, index: number) => Response) {
  const seen: Sent[] = [];
  const http: typeof fetch = async (input, init) => {
    const sent: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(sent);
    return answers(sent, seen.length - 1);
  };
  return { seen, http };
}

function contextWith(
  http: typeof fetch,
  overrides: Partial<ActionContext> = {},
): ActionContext {
  return {
    repo: new Repo(env.DB),
    service: "checkout",
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    ...testActions({ http }),
    ...overrides,
  };
}

function definition(input: Record<string, unknown>) {
  const parsed = actionDefinitionInput.parse({
    label: "Restart the workers",
    spokenDescription: "restart the workers",
    ...input,
  });
  if (parsed.target.kind !== "http") throw new Error("expected an http action");
  return { target: parsed.target as HttpTarget, verify: parsed.verify };
}

const restart = {
  kind: "http",
  method: "POST",
  url: "https://deploy.example.com/services/checkout/restart",
};

const healthy: HttpVerify = {
  url: "https://deploy.example.com/services/checkout/health",
  jsonPath: ["status", "healthy"],
  equals: true,
  attempts: 3,
  delayMs: 0,
  timeoutMs: 5_000,
};

describe("carrying out an action against another system", () => {
  it("sends what the definition says, with the spoken value substituted in", async () => {
    const { seen, http } = transport(() => jsonResponse({ ok: true }));
    const { target, verify } = definition({
      parameters: [
        { name: "release", description: "which release", type: "string" },
      ],
      target: {
        ...restart,
        url: "https://deploy.example.com/releases/{release}/activate",
        body: { release: "{release}", instances: 2 },
      },
    });

    const result = await runHttp(
      target,
      verify,
      { release: "2026-08-19-a" },
      contextWith(http),
    );

    expect(result.outcome).toBe("succeeded");
    expect(seen[0]?.url).toBe(
      "https://deploy.example.com/releases/2026-08-19-a/activate",
    );
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      release: "2026-08-19-a",
      instances: 2,
    });
  });

  /**
   * Substitution walks the parsed body rather than the text of it, so a value cannot close the
   * string it lands in and rewrite the request around itself.
   */
  it("cannot have a spoken value rewrite the request around it", async () => {
    const { seen, http } = transport(() => jsonResponse({ ok: true }));
    const { target } = definition({
      parameters: [
        { name: "release", description: "which release", type: "string" },
      ],
      target: { ...restart, body: { release: "{release}", force: false } },
    });

    await runHttp(
      target,
      null,
      { release: '", "force": true, "x": "' },
      contextWith(http),
    );

    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      release: '", "force": true, "x": "',
      force: false,
    });
  });

  it("sends nothing at all to a host this deployment may not call", async () => {
    const { seen, http } = transport(() => jsonResponse({ ok: true }));
    const { target } = definition({ target: restart });

    const result = await runHttp(
      target,
      null,
      {},
      contextWith(http, { allowedHosts: ["releases.example.com"] }),
    );

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("ACTION_HOST_ALLOWLIST");
    expect(seen).toHaveLength(0);
    expect(result.attempts).toBe(0);
  });

  it("refuses to follow a redirect to somewhere that was never authorized", async () => {
    const { http } = transport(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.com/" },
        }),
    );
    const { target } = definition({ target: restart });

    const result = await runHttp(target, null, {}, contextWith(http));
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("redirected");
  });

  it("sends nothing when the credential it names is not on this deployment", async () => {
    const { seen, http } = transport(() => jsonResponse({ ok: true }));
    const { target } = definition({
      target: {
        ...restart,
        headers: { authorization: { fromSecret: "RUNBOOK_SECRET_DEPLOY" } },
      },
    });

    const result = await runHttp(target, null, {}, contextWith(http));
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("RUNBOOK_SECRET_DEPLOY");
    expect(seen).toHaveLength(0);
  });

  it("puts the credential on the request when the deployment has it", async () => {
    const { seen, http } = transport(() => jsonResponse({ ok: true }));
    const { target } = definition({
      target: {
        ...restart,
        headers: { authorization: { fromSecret: "RUNBOOK_SECRET_DEPLOY" } },
      },
    });

    await runHttp(
      target,
      null,
      {},
      contextWith(http, { secret: () => "a-deploy-token" }),
    );
    expect(seen[0]?.headers.get("authorization")).toBe("a-deploy-token");
  });
});

describe("when the far side does not answer properly", () => {
  it("tries again on a server error, but only when the action says it is idempotent", async () => {
    const failing = transport(() => new Response("nope", { status: 503 }));
    const { target } = definition({
      target: { ...restart, idempotent: true, maxAttempts: 3 },
    });

    const retried = await runHttp(target, null, {}, contextWith(failing.http));
    expect(retried.outcome).toBe("failed");
    expect(retried.attempts).toBe(3);
    expect(failing.seen).toHaveLength(3);

    const once = transport(() => new Response("nope", { status: 503 }));
    const single = definition({ target: restart });
    const notRetried = await runHttp(
      single.target,
      null,
      {},
      contextWith(once.http),
    );
    expect(notRetried.attempts).toBe(1);
    expect(once.seen).toHaveLength(1);
  });

  /**
   * The definition schema already refuses more than one attempt unless the action says running it
   * twice is the same as running it once, so a row like this can only come from somebody writing
   * straight into the database. The executor holds the same line anyway: the rule is about the far
   * side of the request, not about the shape of the row that described it.
   */
  it("sends once even when a stored row asks for retries it may not have", async () => {
    const { seen, http } = transport(
      () => new Response("nope", { status: 503 }),
    );
    const { target } = definition({
      target: { ...restart, idempotent: true, maxAttempts: 3 },
    });

    const result = await runHttp(
      { ...target, idempotent: false },
      null,
      {},
      contextWith(http),
    );
    expect(result.attempts).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("stops on a refusal rather than repeating it", async () => {
    const { seen, http } = transport(
      () => new Response("not allowed", { status: 403 }),
    );
    const { target } = definition({
      target: { ...restart, idempotent: true, maxAttempts: 3 },
    });

    const result = await runHttp(target, null, {}, contextWith(http));
    expect(result.outcome).toBe("failed");
    expect(seen).toHaveLength(1);
  });

  it("succeeds once a retry gets through", async () => {
    const { http } = transport((_sent, index) =>
      index === 0
        ? new Response("busy", { status: 429 })
        : jsonResponse({ ok: true }),
    );
    const { target } = definition({
      target: { ...restart, idempotent: true, maxAttempts: 2 },
    });

    const result = await runHttp(target, null, {}, contextWith(http));
    expect(result.outcome).toBe("succeeded");
    expect(result.attempts).toBe(2);
  });

  it("treats a request that never came back as a failure, not as a refusal", async () => {
    const { http } = transport(() => {
      throw new Error("The operation was aborted due to timeout");
    });
    const { target } = definition({ target: restart });

    const result = await runHttp(target, null, {}, contextWith(http));
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("timeout");
  });
});

describe("checking afterwards that it worked", () => {
  it("reads the system either side of the change and confirms it took", async () => {
    let restarted = false;
    const { http } = transport((sent) => {
      if (sent.method === "POST") {
        restarted = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ status: { healthy: restarted } });
    });
    const { target } = definition({ target: restart });

    const result = await runHttp(target, healthy, {}, contextWith(http));
    expect(result.outcome).toBe("succeeded");
    expect(result.verification).toMatchObject({ verified: true });
    expect(result.stateBefore).toMatchObject({ value: false });
    expect(result.stateAfter).toMatchObject({ value: true });
  });

  /**
   * The action reported success and nothing could confirm it. Saying that plainly is the whole
   * point: the alternative is telling somebody a production problem is fixed because a request
   * returned 200, which is a claim about the request rather than about the system.
   */
  it("says so when the request succeeded and the system did not change", async () => {
    const { http } = transport((sent) =>
      sent.method === "POST"
        ? jsonResponse({ ok: true })
        : jsonResponse({ status: { healthy: false } }),
    );
    const { target } = definition({ target: restart });

    const result = await runHttp(target, healthy, {}, contextWith(http));
    expect(result.outcome).toBe("unverified");
    expect(result.verification).toMatchObject({ verified: false });
    expect(result.detail).toContain("still reads false");
  });

  it("gives the change a moment and takes the later answer", async () => {
    let checks = 0;
    const { http } = transport((sent) => {
      if (sent.method === "POST") return jsonResponse({ ok: true });
      checks += 1;
      return jsonResponse({ status: { healthy: checks >= 2 } });
    });
    const { target } = definition({ target: restart });

    const result = await runHttp(target, healthy, {}, contextWith(http));
    expect(result.outcome).toBe("succeeded");
    expect(checks).toBe(2);
  });

  it("counts a check that cannot be read as a check that did not pass", async () => {
    const { http } = transport((sent) =>
      sent.method === "POST"
        ? jsonResponse({ ok: true })
        : new Response("gone", { status: 404 }),
    );
    const { target } = definition({ target: restart });

    const result = await runHttp(target, healthy, {}, contextWith(http));
    expect(result.outcome).toBe("unverified");
    expect(result.detail).toContain("404");
  });
});
