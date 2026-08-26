import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import { defaultPolicy } from "../src/domain/policy.js";
import { resetTables } from "./support/reset.js";
import { deliverWebhook, terminalCallFor } from "./support/webhook.js";

const ADMIN_TOKEN = "a-long-enough-dummy-admin-token";

type Options = { method?: string; body?: unknown; token?: string };

async function api(path: string, options: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== undefined)
    headers["authorization"] = `Bearer ${options.token}`;

  return SELF.fetch(`https://ringbolt.test${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "PUT"),
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const restart = {
  label: "Restart the workers",
  spokenDescription: "restart the workers, which drops every job in flight",
  confirmationPhrase: "restart the workers",
  minConfidence: 0.85,
  parameters: [
    { name: "reason", description: "why, in their own words", type: "string" },
  ],
  target: {
    kind: "http",
    method: "POST",
    url: "https://actions.ringbolt.test/services/checkout/restart",
    headers: { "x-api-key": { fromSecret: "RUNBOOK_SECRET_DEPLOY" } },
    body: { reason: "{reason}" },
  },
  verify: {
    url: "https://actions.ringbolt.test/services/checkout/health",
    jsonPath: ["status", "healthy"],
    equals: true,
  },
};

describe("writing down what Ringbolt may do", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  /**
   * The two the product ships with are rows like any other, so an operator can edit or remove them
   * without a deploy. They are also the only two that exist on a fresh install, and both of them
   * change state Ringbolt owns rather than reaching out to anybody, which is what makes a first run
   * safe to try.
   */
  it("ships two actions and neither of them reaches outside", async () => {
    const listed = await bodyOf<{
      actions: { id: string; target: { kind: string } }[];
    }>(await api("/api/config/actions"));

    expect(listed.actions.map((action) => action.id)).toEqual([
      "kill_switch",
      "rollback",
    ]);
    expect(
      listed.actions.every((action) => action.target.kind === "service_state"),
    ).toBe(true);
  });

  it("stores a new one, then updates it without losing when it was written", async () => {
    const created = await api("/api/config/actions/restart_workers", {
      body: restart,
    });
    expect(created.status).toBe(201);
    const first = await bodyOf<{ action: { createdAt: string } }>(created);

    const updated = await api("/api/config/actions/restart_workers", {
      body: { ...restart, label: "Restart the worker pool" },
    });
    expect(updated.status).toBe(200);

    const read = await bodyOf<{
      action: { label: string; createdAt: string; minConfidence: number };
    }>(await api("/api/config/actions/restart_workers"));
    expect(read.action.label).toBe("Restart the worker pool");
    expect(read.action.createdAt).toBe(first.action.createdAt);
    expect(read.action.minConfidence).toBe(0.85);
  });

  it("offers a stored action to a policy, and refuses one that was never stored", async () => {
    await api("/api/config/actions/restart_workers", { body: restart });

    const policy = {
      minSeverity: "low",
      quietHours: null,
      allowedActions: ["kill_switch", "restart_workers"],
      flapWindowMinutes: 15,
      maxCallsPerWindow: 1,
      escalateAfterMinutes: 3,
    };
    expect(
      (await api("/api/config/services/checkout", { body: policy })).status,
    ).toBe(200);

    const refused = await api("/api/config/services/checkout", {
      body: { ...policy, allowedActions: ["format_the_disks"] },
    });
    expect(refused.status).toBe(422);
  });

  it("refuses an id that is not one", async () => {
    expect(
      (await api("/api/config/actions/Restart Workers", { body: restart }))
        .status,
    ).toBe(422);
  });

  it("refuses a target inside a private network", async () => {
    const response = await api("/api/config/actions/metadata_grab", {
      body: {
        ...restart,
        verify: null,
        target: {
          kind: "http",
          method: "GET",
          url: "https://169.254.169.254/latest/meta-data/",
        },
      },
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("address literal");
  });

  /**
   * The definitions table is readable through this API and every run is written to the audit trail,
   * so a credential in a definition is a credential in both. It names a binding instead.
   */
  it("refuses a credential typed into the definition", async () => {
    const response = await api("/api/config/actions/restart_workers", {
      body: {
        ...restart,
        target: {
          ...restart.target,
          headers: { Authorization: "Bearer sk-live-not-a-real-token" },
        },
      },
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("fromSecret");
  });

  /**
   * The host allowlist is the same argument as the phone number allowlist: a definition is a row in
   * a table this endpoint writes, so without it the set of systems a deployment can reach is
   * whatever somebody typed in here.
   */
  it("refuses a host this deployment was never told it may call", async () => {
    const response = await api("/api/config/actions/restart_workers", {
      body: {
        ...restart,
        verify: null,
        target: { ...restart.target, url: "https://deploy.example.com/go" },
      },
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("ACTION_HOST_ALLOWLIST");
  });

  it("refuses to delete an action a policy still permits", async () => {
    await api("/api/config/actions/restart_workers", { body: restart });
    await new Repo(env.DB).upsertServicePolicy(
      defaultPolicy(
        "checkout",
        ["kill_switch", "restart_workers"],
        "2026-08-22T10:00:00.000Z",
      ),
    );

    const refused = await api("/api/config/actions/restart_workers", {
      method: "DELETE",
    });
    expect(refused.status).toBe(409);
    expect(
      await new Repo(env.DB).getActionDefinition("restart_workers"),
    ).not.toBeNull();
  });

  it("deletes one nothing points at", async () => {
    await api("/api/config/actions/restart_workers", { body: restart });
    expect(
      (await api("/api/config/actions/restart_workers", { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await api("/api/config/actions/restart_workers")).status).toBe(404);
  });
});

describe("the audit trail", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  afterEach(() => {
    env.ADMIN_TOKEN = "";
  });

  it("carries the transcript, the decision and what ran, in one answer", async () => {
    const accepted = await bodyOf<{ incident: string }>(
      await SELF.fetch(
        "https://ringbolt.test/intake/test-dummy-intake-token-0123456789",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service: "checkout",
            title: "Payment errors above 20 percent",
          }),
        },
      ),
    );

    const call = await terminalCallFor(env.DB, accepted.incident);
    expect((await deliverWebhook(call)).status).toBe(200);

    const audit = await bodyOf<{
      calls: { transcript: unknown[] }[];
      actions: { actionId: string; verification: { verified: boolean } }[];
    }>(await api(`/api/audit/incidents/${accepted.incident}`));

    expect(audit.calls[0]?.transcript.length).toBeGreaterThan(0);
    expect(audit.actions[0]?.actionId).toBe("kill_switch");
    expect(audit.actions[0]?.verification.verified).toBe(true);
  });

  /** A transcript is personal data and the evidence behind a production change. Both are guarded. */
  it("is not readable without the admin token", async () => {
    env.ADMIN_TOKEN = ADMIN_TOKEN;
    expect((await api("/api/audit/incidents/inc_whatever")).status).toBe(401);
    expect(
      (await api("/api/audit/incidents/inc_whatever", { token: ADMIN_TOKEN }))
        .status,
    ).toBe(404);
  });
});
