import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";
import {
  DEMO_SERVICE,
  FAULTY_RELEASE,
  HEALTHY_RELEASE,
} from "../src/demo/service.js";
import type { DemoView, SessionView } from "../src/domain/view.js";
import { allowedActionHosts, readConfig } from "../src/worker/env.js";
import { resetTables } from "./support/reset.js";
import { deliverWebhook, terminalCallFor } from "./support/webhook.js";

const ADMIN_TOKEN = "a-long-enough-dummy-admin-token";

/** Vars the worker reads that are not in the generated binding type, and are mutable from here. */
const vars = env as unknown as Record<string, string | undefined>;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://ringbolt.test${path}`, init);
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function demo(): Promise<DemoView> {
  return bodyOf<DemoView>(await api("/api/demo"));
}

async function breakIt(): Promise<Response> {
  return api("/api/demo/break", { method: "POST" });
}

/** Runs the call the break placed all the way through to whatever it decided. */
async function finishTheCall(incidentId: string): Promise<void> {
  await deliverWebhook(await terminalCallFor(env.DB, incidentId));
}

describe("the demo service", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  afterEach(() => {
    delete vars["DEMO_MODE"];
    delete vars["ADMIN_TOKEN"];
    vars["CALLE_FAKE_SCENARIO"] = "answers";
  });

  it("starts out serving, and says which release it is on", async () => {
    const view = await demo();
    expect(view.service).toBe(DEMO_SERVICE);
    expect(view.health).toBe("serving");
    expect(view.activeRelease).toBe(HEALTHY_RELEASE);
    expect(view.controls.breakIt.available).toBe(true);
    expect(view.controls.repair.available).toBe(false);
  });

  /**
   * The break control is the whole of what a stranger may do, so what it does has to be the product
   * rather than a path built for the demo: a bad release goes out, and Ringbolt hears about it the
   * way it hears about everything else.
   */
  it("puts the bad release out and opens one incident", async () => {
    const response = await breakIt();
    expect(response.status).toBe(202);

    const opened = await bodyOf<{ incident: string; state: string }>(response);
    expect(opened.state).toBe("calling");

    const view = await demo();
    expect(view.health).toBe("failing");
    expect(view.activeRelease).toBe(FAULTY_RELEASE);
    expect(view.previousRelease).toBe(HEALTHY_RELEASE);
    expect(view.incident?.id).toBe(opened.incident);
  });

  /**
   * A visitor pressing the button four times is one phone call, which is the product's own
   * suppression rule rather than something the demo invents. The control refuses before it writes
   * anything, because there is nothing left to break.
   */
  it("refuses to break what is already broken", async () => {
    await breakIt();
    const again = await breakIt();
    expect(again.status).toBe(409);
    expect((await bodyOf<{ error: string }>(again)).error).toContain(
      "already failing",
    );

    const repo = new Repo(env.DB);
    expect((await repo.listIncidents()).length).toBe(1);
  });

  /**
   * The whole loop, on the one service Ringbolt owns: a bad release, a call, a responder who says
   * the words the action demanded, the action, and a service that reads healthy again afterwards.
   * Nothing here is a demo-only shortcut: the same orchestrator, gate and action engine run.
   */
  it("runs the loop from a break back to a healthy service", async () => {
    const opened = await bodyOf<{ incident: string }>(await breakIt());
    await finishTheCall(opened.incident);

    const view = await demo();
    expect(view.health).toBe("serving");
    expect(view.activeRelease).toBe(HEALTHY_RELEASE);
    expect(view.incident).toBeNull();

    const repo = new Repo(env.DB);
    const incident = await repo.getIncident(opened.incident);
    expect(incident?.state).toBe("resolved");
    expect(incident?.outcome).toBe("rollback:succeeded");
  });

  /**
   * The deck draws a line from the sentence that granted permission into the action it allowed, and
   * it draws it only where the words the action required are really in the transcript. A demo whose
   * rehearsed conversation did not contain them would be a demo missing the one graphic this
   * product is about.
   */
  it("is authorized on words the responder is heard saying", async () => {
    const opened = await bodyOf<{ incident: string }>(await breakIt());
    await finishTheCall(opened.incident);

    const repo = new Repo(env.DB);
    const call = (await repo.listCallRecords(opened.incident))[0];
    const said = (
      call?.transcript as { speaker: string; text: string }[]
    ).filter((turn) => turn.speaker === "user");
    expect(said.some((turn) => /roll it back/i.test(turn.text))).toBe(true);

    const run = (await repo.listActionRuns(opened.incident))[0];
    expect(run?.actionId).toBe("rollback");
    expect(run?.outcome).toBe("succeeded");
    expect(
      (run?.decision as { confirmation_phrase: string }).confirmation_phrase,
    ).toBe("roll it back");
  });

  /**
   * Putting the service back underneath a call in flight would leave the record saying something
   * that did not happen: a rollback authorized on a call, against a service somebody had already
   * quietly fixed.
   */
  it("refuses to be put back by hand while Ringbolt is on the call", async () => {
    await breakIt();
    const repair = await api("/api/demo/repair", { method: "POST" });
    expect(repair.status).toBe(409);
    expect((await bodyOf<{ error: string }>(repair)).error).toContain(
      "dealing with this one",
    );
  });

  /**
   * A refused call leaves the demo service broken, which is correct and is also a dead end for the
   * next visitor unless the demo can be put back by hand.
   */
  it("can be put back by hand once nothing is in flight", async () => {
    vars["CALLE_FAKE_SCENARIO"] = "hangs_up";
    const opened = await bodyOf<{ incident: string }>(await breakIt());
    await finishTheCall(opened.incident);

    const repo = new Repo(env.DB);
    expect((await repo.getIncident(opened.incident))?.state).toBe("failed");
    expect((await demo()).health).toBe("failing");

    expect((await api("/api/demo/repair", { method: "POST" })).status).toBe(
      200,
    );
    const view = await demo();
    expect(view.health).toBe("serving");
    expect(view.activeRelease).toBe(HEALTHY_RELEASE);
  });

  /**
   * On any deployment that is not the public demo, the demo surface is guarded exactly like the
   * configuration is. Hono's `/api/demo/*` also matches the bare `/api/demo`, which is the reason
   * this asserts the read as well as the control: the guard covering both is a measurement rather
   * than a reading of the router's documentation.
   */
  it("is behind the same token everything else is", async () => {
    vars["ADMIN_TOKEN"] = ADMIN_TOKEN;
    expect((await api("/api/demo")).status).toBe(401);
    expect((await breakIt()).status).toBe(401);

    const withToken = await api("/api/demo", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(withToken.status).toBe(200);
  });
});

describe("the public demo", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
    vars["DEMO_MODE"] = "true";
  });

  afterEach(() => {
    delete vars["DEMO_MODE"];
    delete vars["ADMIN_TOKEN"];
  });

  /**
   * The read-only half, enforced by the worker rather than by a screen that does not draw a button.
   * A screen that hides a control is not a guard: the request is one curl away.
   */
  it("refuses every write except the demo controls", async () => {
    const json = { "content-type": "application/json" };
    const write = async (path: string, method: string, body?: unknown) =>
      api(path, {
        method,
        headers: json,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    expect(
      (
        await write("/api/config/contacts", "POST", {
          name: "A",
          phone: "+31612345678",
        })
      ).status,
    ).toBe(403);
    expect((await write("/api/config/contacts/con_1", "DELETE")).status).toBe(
      403,
    );
    expect(
      (await write("/api/config/services/dockside", "PUT", {})).status,
    ).toBe(403);
    expect(
      (await write("/api/config/actions/anything", "PUT", {})).status,
    ).toBe(403);
    expect((await breakIt()).status).toBe(202);
  });

  /**
   * The phase's whole claim, in one test. A stranger with no token, on a deployment that has one,
   * can read the board, break the demo service, and watch what happens next.
   */
  it("lets a stranger read it and break the demo service", async () => {
    vars["ADMIN_TOKEN"] = ADMIN_TOKEN;
    expect((await api("/api/audit/board")).status).toBe(200);
    expect((await api("/api/audit/incidents")).status).toBe(200);
    expect((await api("/api/demo")).status).toBe(200);
    expect((await bodyOf<SessionView>(await api("/api/session"))).admin).toBe(
      "demo",
    );

    const opened = await breakIt();
    expect(opened.status).toBe(202);
    const incident = (await bodyOf<{ incident: string }>(opened)).incident;

    await finishTheCall(incident);
    const view = await demo();
    expect(view.health).toBe("serving");
    expect((await new Repo(env.DB).getIncident(incident))?.state).toBe(
      "resolved",
    );
  });

  /**
   * A name is who authorized a production change and belongs in the record. A telephone number is
   * personal data nobody consented to publishing, so it does not leave a public deployment.
   */
  it("withholds telephone numbers", async () => {
    await new Repo(env.DB).createContact({
      id: "con_demo_test",
      name: "Nadia",
      phone: "+31612345678",
      createdAt: new Date().toISOString(),
    });

    const body = await bodyOf<{ contacts: { name: string; phone: string }[] }>(
      await api("/api/config/contacts"),
    );
    expect(body.contacts[0]?.name).toBe("Nadia");
    expect(body.contacts[0]?.phone).not.toContain("31612345678");
  });

  /**
   * The guarantee that no stranger can ever cause a real telephone to ring is a property of the
   * configuration rather than a rule each route has to remember. A deployment wired both ways
   * serves nothing at all and says why.
   */
  it("cannot be in live mode at all", () => {
    const live = {
      RINGBOLT_ENV: "production",
      PUBLIC_BASE_URL: "https://ringbolt.example.com",
      CALLE_MODE: "live",
      CALLE_API_KEY: "test-dummy-key-configuration",
      DEMO_PHONE: "+31612345678",
      CALLE_LOCALE: "en-GB",
      CALLE_REGION: "NL",
    };
    expect(readConfig(live).CALLE_MODE).toBe("live");
    expect(() => readConfig({ ...live, DEMO_MODE: "true" })).toThrow(
      /public demo/i,
    );
  });

  /**
   * An action definition is a row somebody may already have stored, and a stranger can trigger one
   * here. So the guarantee is that no host is reachable rather than that no bad one is.
   */
  it("lets no runbook action reach any host", () => {
    const base = {
      RINGBOLT_ENV: "production",
      PUBLIC_BASE_URL: "https://ringbolt.example.com",
      CALLE_MODE: "fake",
      ACTION_HOST_ALLOWLIST: "actions.example.test",
    };
    expect(allowedActionHosts(readConfig(base))).toEqual([
      "actions.example.test",
    ]);
    expect(
      allowedActionHosts(readConfig({ ...base, DEMO_MODE: "true" })),
    ).toEqual([]);
    // Development is the one place with no allowlist at all. The demo still overrides it.
    expect(
      allowedActionHosts(
        readConfig({
          RINGBOLT_ENV: "development",
          PUBLIC_BASE_URL: "https://ringbolt.example.com",
          CALLE_MODE: "fake",
          DEMO_MODE: "true",
        }),
      ),
    ).toEqual([]);
  });

  /** A typo in the one switch that makes a deployment public is a configuration error, not an off. */
  it("refuses a switch value it cannot read", () => {
    expect(() =>
      readConfig({
        RINGBOLT_ENV: "production",
        PUBLIC_BASE_URL: "https://ringbolt.example.com",
        CALLE_MODE: "fake",
        DEMO_MODE: "yes",
      }),
    ).toThrow(/DEMO_MODE/);
  });
});

describe("the example history", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  afterEach(() => {
    delete vars["DEMO_MODE"];
    delete vars["ADMIN_TOKEN"];
    vars["RINGBOLT_ENV"] = "development";
  });

  /**
   * A product like this one is unreadable empty: the board is a board of nothing and the screen
   * carrying the whole argument cannot be reached at all.
   */
  it("writes an estate once and never twice", async () => {
    const first = await api("/api/demo/seed", { method: "POST" });
    expect(first.status).toBe(201);
    expect(await bodyOf<{ seeded: boolean }>(first)).toEqual({
      seeded: true,
      incidents: 6,
    });

    const again = await api("/api/demo/seed", { method: "POST" });
    expect(again.status).toBe(200);
    expect((await bodyOf<{ seeded: boolean }>(again)).seeded).toBe(false);

    const repo = new Repo(env.DB);
    expect((await repo.listIncidents()).length).toBe(6);
    expect((await demo()).controls.seed.available).toBe(false);
  });

  /**
   * Every outcome the product has, so a stranger can see a refusal and a resolution side by side.
   * The call nobody was heard on is the important one: it is the call this product has actually
   * made, and it carries a schema-valid instruction to change production that Ringbolt refused.
   */
  it("shows a resolution, a refusal, and the call nobody was heard on", async () => {
    await api("/api/demo/seed", { method: "POST" });
    const repo = new Repo(env.DB);

    const states = (await repo.listIncidents()).map((one) => one.state);
    expect(new Set(states)).toEqual(
      new Set([
        "resolved",
        "held",
        "filtered",
        "failed",
        "snoozed",
        "deferred",
      ]),
    );

    const unheard = await repo.listCallRecords("inc_demo_past_unheard");
    const turns = unheard[0]?.transcript as { speaker: string; text: string }[];
    expect(
      turns
        .filter((turn) => turn.speaker === "user")
        .every((turn) => turn.text === ""),
    ).toBe(true);

    const runs = await repo.listActionRuns("inc_demo_past_rollback");
    expect(runs[0]?.authorizedBy).toBe("Ivo Haring");
  });

  /**
   * The estate carries two fictional contacts and puts them in the shared rota when there is no
   * rota yet. On an install somebody is actually on call for, that would quietly point Ringbolt at
   * a number no network can route, which is the worst thing an example history could do.
   */
  it("is refused on a deployment somebody might be on call for", async () => {
    vars["RINGBOLT_ENV"] = "production";
    vars["ADMIN_TOKEN"] = ADMIN_TOKEN;
    const seed = { method: "POST", headers: authorized() };

    const refused = await api("/api/demo/seed", seed);
    expect(refused.status).toBe(409);
    expect((await bodyOf<{ error: string }>(refused)).error).toContain(
      "contacts",
    );
    expect((await new Repo(env.DB).listContacts()).length).toBe(0);

    vars["DEMO_MODE"] = "true";
    expect((await api("/api/demo/seed", seed)).status).toBe(201);
  });

  /** Two of them are still open, so the board a visitor meets is a board with something on it. */
  it("leaves the board with something on it", async () => {
    await api("/api/demo/seed", { method: "POST" });
    vars["DEMO_MODE"] = "true";

    const board = await bodyOf<{
      focus: { incident: { service: string } } | null;
      standing: unknown[];
      counts: { open: number };
    }>(await api("/api/audit/board"));

    expect(board.counts.open).toBe(2);
    expect(board.focus).not.toBeNull();
    expect(board.standing.length).toBe(1);
  });
});
