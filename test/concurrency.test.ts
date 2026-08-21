import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSnapshot } from "../src/calle/port.js";
import type { VerifiedCall } from "../src/calle/verify.js";
import { Repo } from "../src/db/repo.js";
import {
  type AlertPayload,
  openIncidentStates,
} from "../src/domain/incident.js";
import type { Exclusive } from "../src/domain/orchestrator.js";
import { readConfig } from "../src/worker/env.js";
import { buildOrchestrator, immediateScheduler } from "../src/worker/wiring.js";

const TOKEN = "test-intake-token-0123456789";

/**
 * What the Durable Object's section does, in one isolate: run the callbacks one at a time. It is
 * the shape of the guarantee under test, so the same two calls can be run with it and without it.
 */
function oneAtATime(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Nothing at all, which is what the Durable Object was actually providing before this branch. */
const noSection: Exclusive = (work) => work();

function orchestratorWith(exclusive: Exclusive) {
  return buildOrchestrator(env, readConfig(env), {
    scheduler: immediateScheduler,
    exclusive,
  });
}

async function callWaitingOnADecision(alert: {
  service: string;
  title: string;
}): Promise<{ incidentId: string; snapshot: VerifiedCall }> {
  const response = await SELF.fetch(`https://ringbolt.test/intake/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alert),
  });
  const accepted = (await response.json()) as { incident: string };

  const snapshot = await vi.waitFor(
    async () => {
      const rows = await env.DB.prepare(`SELECT snapshot FROM fake_calls`).all<{
        snapshot: string;
      }>();
      const match = rows.results
        .map((row) => JSON.parse(row.snapshot) as CallSnapshot)
        .find(
          (call) =>
            call.metadata["incident_id"] === accepted.incident &&
            call.status !== "queued",
        );
      if (match === undefined) throw new Error("the call is still running");
      return match;
    },
    { timeout: 5000, interval: 25 },
  );

  return { incidentId: accepted.incident, snapshot: snapshot as VerifiedCall };
}

async function countOf(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

const repeatedAlert: AlertPayload = {
  service: "payments",
  title: "Card declines spiking",
  severity: "high",
};

describe("two messages about one incident", () => {
  beforeEach(async () => {
    for (const table of [
      "incident_events",
      "action_runs",
      "processed_events",
      "call_ledger",
      "incidents",
      "service_state",
      "fake_calls",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  /**
   * The window this branch exists to close, reproduced rather than argued. Two terminal deliveries
   * for one incident, each with its own event id, both read state 'calling' before either writes,
   * and the authorized action runs twice. On this product that is a production change applied
   * twice, and a rollback applied twice puts the broken release back.
   *
   * It stays in the suite as the negative control for the two tests below: without it, a guard that
   * had quietly stopped guarding would still look green.
   */
  it("both act when nothing holds the section", async () => {
    const { snapshot } = await callWaitingOnADecision({
      service: "checkout",
      title: "Payment errors above 20 percent",
    });
    const orchestrator = orchestratorWith(noSection);

    await Promise.all([
      orchestrator.onCallTerminal(snapshot),
      orchestrator.onCallTerminal(snapshot),
    ]);

    expect(await countOf("action_runs")).toBe(2);
  });

  it("one acts when the section is held", async () => {
    const { snapshot } = await callWaitingOnADecision({
      service: "checkout",
      title: "Payment errors above 20 percent",
    });
    const orchestrator = orchestratorWith(oneAtATime());

    await Promise.all([
      orchestrator.onCallTerminal(snapshot),
      orchestrator.onCallTerminal(snapshot),
    ]);

    expect(await countOf("action_runs")).toBe(1);
  });

  /**
   * The same pair through the real owner. The local workers pool delivers messages to one Durable
   * Object in series of its own accord, so this cannot reproduce the window the way the test above
   * does; it is the regression guard for the wiring, and the section itself is what the pair above
   * measures.
   */
  it("one acts when the two go through the Durable Object", async () => {
    const { snapshot } = await callWaitingOnADecision({
      service: "search",
      title: "Latency above 5 seconds",
    });

    const namespace = env.INCIDENT;
    const owner = namespace.get(
      namespace.idFromName(await fingerprintOf(snapshot)),
    ) as unknown as { callTerminal(call: CallSnapshot): Promise<void> };

    await Promise.all([
      owner.callTerminal(snapshot),
      owner.callTerminal(snapshot),
    ]);

    expect(await countOf("action_runs")).toBe(1);
  });

  /**
   * The same race on the way in. Two repeats of one alert arriving together both fail to find an
   * open incident, and both try to create one, which is two phone calls to the same person. The
   * database's unique index on open fingerprints is the layer that catches it even here, with no
   * section held, and the collision is answered as the duplicate it is rather than as an error.
   */
  it("a repeat cannot become a second incident even with no section", async () => {
    const orchestrator = orchestratorWith(noSection);

    const results = await Promise.all([
      orchestrator.open(repeatedAlert),
      orchestrator.open(repeatedAlert),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "created",
      "duplicate",
    ]);
    expect(await countOf("incidents")).toBe(1);
    expect(await countOf("fake_calls")).toBe(1);
  });

  it("a repeat is answered from the open incident when the section is held", async () => {
    const orchestrator = orchestratorWith(oneAtATime());

    const results = await Promise.all([
      orchestrator.open(repeatedAlert),
      orchestrator.open(repeatedAlert),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "created",
      "duplicate",
    ]);
    expect(await countOf("incidents")).toBe(1);
    expect(await countOf("fake_calls")).toBe(1);
  });

  /**
   * The index and the duplicate check have to agree on what "open" means. If a state is open to one
   * and not the other, the disagreement is a second phone call, and it would show up nowhere else:
   * both halves keep passing their own tests. So they are compared here rather than trusted to a
   * comment on each.
   */
  it("keeps the database index and the duplicate check on one list of open states", () => {
    const index = env.TEST_MIGRATIONS.flatMap(
      (migration) => migration.queries,
    ).find((query) => query.includes("incidents_one_open_per_fingerprint"));
    expect(index).toBeDefined();

    const listed = [...(index ?? "").matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(listed.sort()).toEqual([...openIncidentStates].sort());
  });

  it("refuses to open two incidents for one fingerprint at the database", async () => {
    const orchestrator = orchestratorWith(oneAtATime());
    const opened = await orchestrator.open(repeatedAlert);
    expect(opened.kind).toBe("created");

    const second = { ...opened.incident, id: "inc_forced_second" };
    await expect(new Repo(env.DB).createIncident(second)).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
    expect(await countOf("incidents")).toBe(1);
  });
});

async function fingerprintOf(snapshot: VerifiedCall): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT fingerprint FROM incidents WHERE id = ?1`,
  )
    .bind(snapshot.metadata["incident_id"])
    .first<{ fingerprint: string }>();
  if (row === null) throw new Error("the incident vanished");
  return row.fingerprint;
}
