import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1FakeCallStore, FakeCallPlacer } from "../src/calle/fake.js";
import { LiveCallPlacer } from "../src/calle/live.js";
import type { CallPlacer, PlaceCallInput } from "../src/calle/port.js";
import { verifyCall } from "../src/calle/verify.js";
import { calleApiStub } from "./support/calle-api.js";

/**
 * The contract every telephone has to satisfy, written against the interface rather than against
 * any one implementation. The CALL-E adapter joins this suite by adding a line to the list below,
 * which is the point: an adapter that has not been run through these has not been held to anything.
 */
const implementations: { name: string; build: () => CallPlacer }[] = [
  {
    name: "the local stand-in",
    build: () =>
      new FakeCallPlacer({
        store: new D1FakeCallStore(env.DB, () => new Date()),
        scheduler: () => undefined,
        scenarioFor: () => ({
          kind: "answers",
          decision: { decision: "hold" },
        }),
      }),
  },
  {
    name: "the CALL-E adapter",
    build: () =>
      new LiveCallPlacer({
        apiKey: "test-key-contract-suite",
        budget: { spent: async () => 0 },
        // A host that resolves to nothing, so a transport that failed to be installed would fail
        // loudly rather than reach the real API with the suite's made-up key.
        baseUrl: "https://calle.invalid",
        fetchImpl: calleApiStub().fetch,
      }),
  },
];

function callFor(key: string): PlaceCallInput {
  return {
    phone: "+00000000000",
    task: "Tell the responder what has broken and ask what to do.",
    resultSchema: { type: "object" },
    metadata: { incident_id: "inc_contract", service: "checkout" },
    webhookUrl: "https://ringbolt.test/webhooks/calle",
    idempotencyKey: key,
  };
}

describe.each(implementations)("$name", ({ build }) => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM fake_calls`).run();
  });

  it("answers a placed call with an id that can be read back", async () => {
    const placer = build();
    const placed = await placer.place(callFor("inc_contract:attempt-1"));

    expect(placed.id).not.toBe("");
    const read = await placer.get(placed.id);
    expect(read.id).toBe(placed.id);
  });

  /**
   * The property that stops a retried create becoming a second phone call to a real person, which
   * is not recoverable once it has happened.
   */
  it("returns the same call for a repeated idempotency key", async () => {
    const placer = build();
    const first = await placer.place(callFor("inc_contract:attempt-1"));
    const second = await placer.place(callFor("inc_contract:attempt-1"));

    expect(second.id).toBe(first.id);
  });

  it("keeps two different keys apart", async () => {
    const placer = build();
    const first = await placer.place(callFor("inc_contract:attempt-1"));
    const second = await placer.place(callFor("inc_other:attempt-1"));

    expect(second.id).not.toBe(first.id);
  });

  it("carries the metadata that names the incident", async () => {
    const placer = build();
    const placed = await placer.place(callFor("inc_contract:attempt-1"));

    expect((await placer.get(placed.id)).metadata["incident_id"]).toBe(
      "inc_contract",
    );
  });

  it("refuses to answer for a call it does not have", async () => {
    await expect(build().get("call_never_existed")).rejects.toThrow();
  });

  it("returns a snapshot the verification step accepts", async () => {
    const placer = build();
    const placed = await placer.place(callFor("inc_contract:attempt-1"));

    await expect(verifyCall(placer, placed.id)).resolves.toMatchObject({
      id: placed.id,
    });
  });
});
