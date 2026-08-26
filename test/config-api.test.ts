import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import { resetTables } from "./support/reset.js";

const ADMIN_TOKEN = "a-long-enough-dummy-admin-token";

type Options = { token?: string; body?: unknown; method?: string };

async function config(path: string, options: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== undefined)
    headers["authorization"] = `Bearer ${options.token}`;

  return SELF.fetch(`https://ringbolt.test/api/config${path}`, {
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

const aPolicy = {
  minSeverity: "high",
  quietHours: {
    startMinute: 1320,
    endMinute: 420,
    zone: "Europe/Amsterdam",
    minSeverity: "critical",
  },
  allowedActions: ["kill_switch"],
  flapWindowMinutes: 20,
  maxCallsPerWindow: 1,
  escalateAfterMinutes: 4,
};

describe("the configuration endpoints", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  it("lists the actions a policy may permit", async () => {
    const response = await config("/actions");
    expect(response.status).toBe(200);

    const listed = await bodyOf<{ actions: { id: string }[] }>(response);
    expect(listed.actions.map((action) => action.id)).toEqual([
      "kill_switch",
      "rollback",
    ]);
  });

  /** An action definition read out on a call is a script, not a function, so it carries no code. */
  it("does not publish how an action is carried out", async () => {
    const listed = await bodyOf<{ actions: Record<string, unknown>[] }>(
      await config("/actions"),
    );
    expect(listed.actions[0]).not.toHaveProperty("run");
  });

  it("reports the built-in policy for a service nobody has configured", async () => {
    const response = await config("/services/checkout");
    const body = await bodyOf<{
      configured: boolean;
      policy: { minSeverity: string };
    }>(response);

    expect(body.configured).toBe(false);
    expect(body.policy.minSeverity).toBe("low");
  });

  it("stores a policy and reads it back", async () => {
    expect((await config("/services/checkout", { body: aPolicy })).status).toBe(
      200,
    );

    const body = await bodyOf<{
      configured: boolean;
      policy: typeof aPolicy;
    }>(await config("/services/checkout"));
    expect(body.configured).toBe(true);
    expect(body.policy.quietHours?.zone).toBe("Europe/Amsterdam");
    expect(body.policy.allowedActions).toEqual(["kill_switch"]);
  });

  /**
   * An action that does not exist would silently narrow what can be offered on a call, which shows
   * up at three in the morning as a responder being read a shorter list than anybody intended.
   */
  it("refuses a policy naming an action this build does not have", async () => {
    const response = await config("/services/checkout", {
      body: { ...aPolicy, allowedActions: ["format_the_disks"] },
    });
    expect(response.status).toBe(422);
  });

  it("refuses a time zone the runtime cannot resolve", async () => {
    const response = await config("/services/checkout", {
      body: {
        ...aPolicy,
        quietHours: { ...aPolicy.quietHours, zone: "Nowhere/Imaginary" },
      },
    });
    expect(response.status).toBe(422);
  });

  it("adds a contact and puts them in a rotation", async () => {
    const created = await config("/contacts", {
      method: "POST",
      body: { name: "the first responder", phone: "+31612345678" },
    });
    expect(created.status).toBe(201);
    const { contact } = await bodyOf<{ contact: { id: string } }>(created);

    const set = await config("/rotation/checkout", {
      body: { contactIds: [contact.id] },
    });
    expect(set.status).toBe(200);

    const rota = await bodyOf<{
      contacts: { id: string }[];
      own: boolean;
      usesConfiguredNumber: boolean;
    }>(await config("/rotation/checkout"));
    expect(rota.contacts.map((one) => one.id)).toEqual([contact.id]);
    expect(rota.own).toBe(true);
    expect(rota.usesConfiguredNumber).toBe(false);
  });

  it("says plainly that an empty rotation calls the configured number", async () => {
    const rota = await bodyOf<{ usesConfiguredNumber: boolean }>(
      await config("/rotation/search"),
    );
    expect(rota.usesConfiguredNumber).toBe(true);
  });

  it("refuses a contact whose number is not a real one", async () => {
    const response = await config("/contacts", {
      method: "POST",
      body: { name: "nobody", phone: "0612345678" },
    });
    expect(response.status).toBe(422);
  });

  /**
   * Escalating to the same person twice is not escalating. It would read as a two-deep rota on
   * screen and behave like a one-deep one at three in the morning.
   */
  it("refuses a rotation that names the same person twice", async () => {
    const { contact } = await bodyOf<{ contact: { id: string } }>(
      await config("/contacts", {
        method: "POST",
        body: { name: "the first responder", phone: "+31612345678" },
      }),
    );

    const response = await config("/rotation/checkout", {
      body: { contactIds: [contact.id, contact.id] },
    });
    expect(response.status).toBe(422);
  });

  it("refuses a rotation naming somebody who does not exist", async () => {
    const response = await config("/rotation/checkout", {
      body: { contactIds: ["con_nobody"] },
    });
    expect(response.status).toBe(422);
  });

  /**
   * Deleting somebody who is still in a rota would shorten it silently, and a rotation one person
   * shorter than the operator believes is discovered during an incident.
   */
  it("refuses to delete a contact who is still in a rotation", async () => {
    const { contact } = await bodyOf<{ contact: { id: string } }>(
      await config("/contacts", {
        method: "POST",
        body: { name: "the first responder", phone: "+31612345678" },
      }),
    );
    await config("/rotation/checkout", { body: { contactIds: [contact.id] } });

    const refused = await config(`/contacts/${contact.id}`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(409);
    expect(await new Repo(env.DB).getContact(contact.id)).not.toBeNull();

    await config("/rotation/checkout", { body: { contactIds: [] } });
    expect(
      (await config(`/contacts/${contact.id}`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("answers a delete for a contact that is not there", async () => {
    expect(
      (await config("/contacts/con_nobody", { method: "DELETE" })).status,
    ).toBe(404);
  });

  /**
   * Erasure rewrites history and cannot be undone, so it is its own endpoint rather than a flag on
   * delete. Everything it changed comes back as counts, because somebody has to be able to answer
   * the person who asked.
   */
  it("erases a contact from the record and says how much it changed", async () => {
    const { contact } = await bodyOf<{ contact: { id: string } }>(
      await config("/contacts", {
        method: "POST",
        body: { name: "Marit", phone: "+31612345678" },
      }),
    );

    const response = await config(`/contacts/${contact.id}/erase`, {
      method: "POST",
    });
    expect(response.status).toBe(200);

    const erased = await bodyOf<{ erased: Record<string, number> }>(response);
    expect(erased.erased).toMatchObject({
      calls: 0,
      actionRuns: 0,
      incidents: 0,
      events: 0,
    });
    expect(await new Repo(env.DB).getContact(contact.id)).toBeNull();
  });

  it("refuses to erase somebody who is still on call", async () => {
    const { contact } = await bodyOf<{ contact: { id: string } }>(
      await config("/contacts", {
        method: "POST",
        body: { name: "Marit", phone: "+31612345678" },
      }),
    );
    await config("/rotation/checkout", { body: { contactIds: [contact.id] } });

    const refused = await config(`/contacts/${contact.id}/erase`, {
      method: "POST",
    });
    expect(refused.status).toBe(409);
    expect(await new Repo(env.DB).getContact(contact.id)).not.toBeNull();
  });

  it("answers an erasure for a contact that is not there", async () => {
    expect(
      (await config("/contacts/con_nobody/erase", { method: "POST" })).status,
    ).toBe(404);
  });
});

/**
 * These endpoints decide which telephone rings. Authentication proper is phase 7, and this is the
 * floor until then: outside development they refuse to serve at all until a token exists, which
 * fails closed rather than shipping an open door nobody notices.
 */
describe("who may change the configuration", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    env.ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterEach(() => {
    env.ADMIN_TOKEN = "";
  });

  it("refuses a request with no token once one is configured", async () => {
    expect((await config("/contacts")).status).toBe(401);
  });

  it("refuses the wrong token", async () => {
    expect(
      (await config("/contacts", { token: "not-the-dummy-admin-token" }))
        .status,
    ).toBe(401);
  });

  it("lets the right token through", async () => {
    expect((await config("/contacts", { token: ADMIN_TOKEN })).status).toBe(
      200,
    );
  });

  it("guards writing as well as reading", async () => {
    const response = await config("/services/checkout", { body: aPolicy });
    expect(response.status).toBe(401);

    const withToken = await config("/services/checkout", {
      token: ADMIN_TOKEN,
      body: aPolicy,
    });
    expect(withToken.status).toBe(200);
  });

  /** Contacts carry phone numbers, so reading them is guarded exactly as writing them is. */
  it("does not publish anybody's phone number to an unauthorized caller", async () => {
    await new Repo(env.DB).createContact({
      id: "con_listed",
      name: "the first responder",
      phone: "+31612345678",
      createdAt: new Date().toISOString(),
    });

    const refused = await config("/contacts");
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain("+31612345678");
  });
});
