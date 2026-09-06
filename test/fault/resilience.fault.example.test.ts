// tsconfig-coverage: ignore (excluded in tsconfig.json: cockatiel and toxiproxy-node-client are
// not installed until the attack pass wires the fault job; drop this marker and the exclude then)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Toxiproxy } from "toxiproxy-node-client";
import { circuitBreaker, retry, handleAll, ConsecutiveBreaker, ConstantBackoff, BrokenCircuitError } from "cockatiel";

// WAVE 2 fault injection (attack stage). PROVES the resilience stack actually fires: an injected
// dependency fault must trip the retry + circuit breaker, and the OPEN breaker must SHIELD the
// downstream (stop sending it traffic). A unit test with a mocked client can never prove this -
// only a real fault on the wire (Toxiproxy) can.
//
// Toxiproxy is a TEST-TIME dependency, not shipped in the product. Provide it at test time,
// loopback only (never bind 0.0.0.0):
//   - local:  download the toxiproxy-server binary (github.com/Shopify/toxiproxy releases),
//             run `toxiproxy-server -host 127.0.0.1`.
//   - CI:     add a `toxiproxy` service container to the job (ghcr.io/shopify/toxiproxy).
// Name your real fault tests `*.fault.test.ts` and run them in a dedicated fault job (this example
// is named `.fault.example.test.ts` only because it is a template). Replace the downstream stub +
// the proxied call with your real dependency.

const ADMIN = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:8474";
// Fixed proxy name + port, and a GLOBAL reset() in beforeAll/afterAll: every fault test shares the
// one Toxiproxy server, so they MUST run serially (vitest `fileParallelism: false` in the fault
// config). Two fault FILES in parallel would collide on this port and reset() away each other's
// toxics mid-run. Give each file a unique name+port only if you genuinely need parallel fault suites.
const PROXY_LISTEN = "127.0.0.1:11000"; // loopback only
const PROXY_URL = "http://127.0.0.1:11000/";

// Probe Toxiproxy ONCE at load. When it is absent the whole suite is SKIPPED (the runner shows it
// gray), never silently PASSED - a green fault test that never ran is a false "resilience verified"
// signal. Bounded by a 3s timeout so a firewalled/DROPped host (which never refuses - it just
// hangs) cannot hang test collection; on timeout the suite skips. (In CI, wait for the Toxiproxy
// port to be open before this job so a slow-to-start server is not mistaken for "down".)
const toxiproxyUp = await Promise.race([
  new Toxiproxy(ADMIN).reset().then(() => true).catch(() => false),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000).unref()),
]);

let downstream: Server;
let downstreamHits = 0;

describe.skipIf(!toxiproxyUp)("resilience under an injected dependency fault", () => {
  beforeAll(async () => {
    downstream = createServer((_req, res) => {
      downstreamHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", () => resolve()));
    const dsPort = (downstream.address() as { port: number }).port;

    const toxi = new Toxiproxy(ADMIN);
    await toxi.reset();
    try {
      await (await toxi.get("fault-demo")).remove(); // clear a leftover proxy from a prior run
    } catch {
      /* not present */
    }
    await toxi.createProxy({ name: "fault-demo", listen: PROXY_LISTEN, upstream: `127.0.0.1:${dsPort}` });
  });

  afterAll(async () => {
    try {
      await new Toxiproxy(ADMIN).reset();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => downstream?.close(() => resolve()));
  });

  it("baseline: a healthy call succeeds through the proxy", async () => {
    expect((await fetch(PROXY_URL)).status).toBe(200);
  });

  it("injected latency trips retries then opens the breaker, shielding the downstream", async () => {
    const breaks: number[] = [];
    const breaker = circuitBreaker(handleAll, { halfOpenAfter: 10_000, breaker: new ConsecutiveBreaker(2) });
    breaker.onBreak(() => breaks.push(1));
    const retryPolicy = retry(handleAll, { maxAttempts: 3, backoff: new ConstantBackoff(10) });

    let attempts = 0;
    const callOnce = () =>
      retryPolicy.execute(async () => {
        attempts++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 80);
        try {
          const res = await fetch(PROXY_URL, { signal: ctrl.signal });
          await res.text();
          return res.status;
        } finally {
          clearTimeout(timer);
        }
      });

    // 5s of downstream latency vs an 80ms client deadline -> every call fails.
    const proxy = await new Toxiproxy(ADMIN).get("fault-demo");
    await proxy.addToxic({ name: "lag", type: "latency", stream: "downstream", toxicity: 1.0, attributes: { latency: 5_000, jitter: 0 } });

    await expect(breaker.execute(callOnce)).rejects.toThrow();
    await expect(breaker.execute(callOnce)).rejects.toThrow();
    const hitsAfterFailures = downstreamHits;

    let brokenCircuit = false;
    try {
      await breaker.execute(callOnce);
    } catch (err) {
      brokenCircuit = err instanceof BrokenCircuitError;
    }
    const hitsAfterOpen = downstreamHits;

    // cockatiel maxAttempts:3 = 3 retries AFTER the initial = 4 calls per execute, x2 executions = 8.
    expect(attempts).toBeGreaterThanOrEqual(8); // retry fired its full budget on both executions
    expect(breaks.length).toBe(1); // breaker opened once
    expect(brokenCircuit).toBe(true); // open breaker rejected the next call
    expect(hitsAfterOpen).toBe(hitsAfterFailures); // ZERO new downstream traffic while open

    await new Toxiproxy(ADMIN).reset();
  });
});
