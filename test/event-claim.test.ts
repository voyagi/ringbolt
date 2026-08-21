import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo.js";

const NOW = "2026-08-21T12:00:00.000Z";
const TWO_MINUTES_EARLIER = "2026-08-21T11:58:00.000Z";
const LATER = "2026-08-21T12:05:00.000Z";
const STALE_BEFORE_LATER = "2026-08-21T12:03:00.000Z";

describe("claiming a webhook event id", () => {
  let repo: Repo;

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM processed_events`).run();
    repo = new Repo(env.DB);
  });

  it("gives the id to exactly one of two deliveries", async () => {
    const results = await Promise.all([
      repo.claimEvent("evt_a", NOW, TWO_MINUTES_EARLIER),
      repo.claimEvent("evt_a", NOW, TWO_MINUTES_EARLIER),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  /**
   * The failure that made this two-phase. A delivery that claims the id and then cannot finish used
   * to keep it for ever, and the provider's retry, which is the only recovery this design has, was
   * answered as a duplicate. Releasing puts the decision back within reach.
   */
  it("lets a retry through after a failed delivery releases the id", async () => {
    expect(await repo.claimEvent("evt_b", NOW, TWO_MINUTES_EARLIER)).toBe(true);
    expect(await repo.claimEvent("evt_b", NOW, TWO_MINUTES_EARLIER)).toBe(
      false,
    );

    await repo.releaseEvent("evt_b");
    expect(await repo.claimEvent("evt_b", NOW, TWO_MINUTES_EARLIER)).toBe(true);
  });

  it("keeps the id for good once the work is complete", async () => {
    await repo.claimEvent("evt_c", NOW, TWO_MINUTES_EARLIER);
    await repo.completeEvent("evt_c", NOW);

    expect(await repo.claimEvent("evt_c", LATER, STALE_BEFORE_LATER)).toBe(
      false,
    );
    await repo.releaseEvent("evt_c");
    expect(await repo.claimEvent("evt_c", LATER, STALE_BEFORE_LATER)).toBe(
      false,
    );
  });

  /**
   * A delivery whose isolate dies releases nothing, so the claim has to expire on its own or the
   * decision is stranded exactly as it was before.
   */
  it("takes over a claim left in flight by a delivery that never came back", async () => {
    expect(await repo.claimEvent("evt_d", NOW, TWO_MINUTES_EARLIER)).toBe(true);
    expect(await repo.claimEvent("evt_d", LATER, STALE_BEFORE_LATER)).toBe(
      true,
    );
  });

  it("removes ids past their retention window and keeps recent ones", async () => {
    await repo.claimEvent("evt_old", "2026-07-01T00:00:00.000Z", NOW);
    await repo.completeEvent("evt_old", "2026-07-01T00:00:00.000Z");
    await repo.claimEvent("evt_new", NOW, TWO_MINUTES_EARLIER);

    expect(await repo.pruneProcessedEvents("2026-08-01T00:00:00.000Z")).toBe(1);

    const remaining = await env.DB.prepare(
      `SELECT event_id FROM processed_events`,
    ).all<{ event_id: string }>();
    expect(remaining.results.map((row) => row.event_id)).toEqual(["evt_new"]);
  });
});
