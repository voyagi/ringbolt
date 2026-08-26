import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardView, SessionView } from "../src/domain/view.js";
import {
  ARRIVAL_BUCKET_MINUTES,
  bucketArrivals,
  readTranscript,
} from "../src/worker/board.js";
import { resetTables } from "./support/reset.js";
import { deliverWebhook, terminalCallFor } from "./support/webhook.js";

const ADMIN_TOKEN = "a-long-enough-dummy-admin-token";

async function api(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return SELF.fetch(`https://ringbolt.test${path}`, { headers });
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function raise(
  alert: Record<string, unknown>,
): Promise<{ incident: string }> {
  const response = await SELF.fetch(
    "https://ringbolt.test/intake/test-dummy-intake-token-0123456789",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
    },
  );
  return bodyOf<{ incident: string }>(response);
}

describe("what the deck is allowed to say", () => {
  beforeEach(async () => {
    await resetTables(env.DB);
  });

  afterEach(() => {
    delete env.ADMIN_TOKEN;
  });

  /**
   * The board carries the live call's transcript, which is personal data and is also the evidence
   * behind a production change. It is guarded for the same reason the audit trail is.
   */
  it("is not readable without the admin token", async () => {
    env.ADMIN_TOKEN = ADMIN_TOKEN;
    expect((await api("/api/audit/board")).status).toBe(401);
    expect((await api("/api/audit/board", ADMIN_TOKEN)).status).toBe(200);
    expect((await api("/api/audit/incidents")).status).toBe(401);
  });

  /**
   * The dashboard has to be able to tell "you need a token" from "the server is broken", or it shows
   * the same spinner for both and an operator is left guessing at three in the morning. Nothing here
   * is a secret: it says a token is required, never what it is.
   */
  it("says whether a token is wanted, without being one", async () => {
    const open = await bodyOf<SessionView>(await api("/api/session"));
    expect(open.admin).toBe("open");
    expect(open.calleMode).toBe("fake");

    env.ADMIN_TOKEN = ADMIN_TOKEN;
    const guarded = await bodyOf<SessionView>(await api("/api/session"));
    expect(guarded.admin).toBe("token");
    expect(JSON.stringify(guarded)).not.toContain(ADMIN_TOKEN);
  });

  /**
   * The focus is the incident the whole left and centre of the deck is about. Two things ring at
   * once often enough that picking one has to be a rule rather than whichever row came back first,
   * and the rule is the more severe one.
   */
  it("focuses the most severe thing on the phone and stands the rest down", async () => {
    const low = await raise({
      service: "mailer",
      title: "Queue depth past twelve thousand",
      severity: "low",
    });
    const bad = await raise({
      service: "checkout",
      title: "Payment errors above 20 percent",
      severity: "critical",
    });

    const board = await bodyOf<BoardView>(await api("/api/audit/board"));
    expect(board.focus?.incident.id).toBe(bad.incident);
    expect(board.focus?.incident.service).toBe("checkout");
    expect(board.standing.map((one) => one.id)).toEqual([low.incident]);
    expect(board.counts.open).toBe(2);
    expect(board.counts.onTheLine).toBe(2);
  });

  /** An empty estate is a state the deck has to have an answer for, not an error. */
  it("answers with nothing in focus when nothing is open", async () => {
    const board = await bodyOf<BoardView>(await api("/api/audit/board"));
    expect(board.focus).toBeNull();
    expect(board.standing).toEqual([]);
    expect(board.counts).toEqual({
      open: 0,
      onTheLine: 0,
      actedToday: 0,
      refusedToday: 0,
    });
    expect(board.rota.usesConfiguredNumber).toBe(true);
    expect(Date.parse(board.now)).not.toBeNaN();
  });

  /**
   * The ring counts against the SERVER's clock, so the board has to send one. A laptop several
   * minutes out is ordinary, and a call that reads as having run for minus four minutes reads as a
   * bug in Ringbolt rather than as a clock disagreeing.
   */
  it("carries the whole loop through to what the deck draws", async () => {
    const opened = await raise({
      service: "checkout",
      title: "Payment errors above 20 percent",
      severity: "critical",
      source: "prometheus",
    });

    const call = await terminalCallFor(env.DB, opened.incident);
    expect((await deliverWebhook(call)).status).toBe(200);

    const board = await bodyOf<BoardView>(await api("/api/audit/board"));
    // The incident resolved, so nothing is open and the deck shows it as the last thing that
    // happened rather than as standing.
    expect(board.counts.actedToday).toBe(1);
    expect(board.budget.realCallsPlaced).toBe(0);

    const record = await bodyOf<{
      incident: { id: string; callId?: string };
      calls: { transcript: { speaker: string; text: string }[] }[];
      actions: { actionId: string; verification: unknown }[];
    }>(await api(`/api/audit/incidents/${opened.incident}`));

    expect(record.calls[0]?.transcript.length).toBeGreaterThan(0);
    expect(record.actions[0]?.actionId).toBe("kill_switch");
    // The call id never leaves the service: it is the one value the unauthenticated webhook route
    // accepts from an anonymous body.
    expect(record.incident.callId).toBeUndefined();
  });

  /**
   * The arrival trace is the only time series this product genuinely holds, because it consumes
   * alerts rather than measuring anything. Every bucket is present even when empty, or a quiet hour
   * and a busy minute would be drawn the same width.
   */
  it("draws every arrival bucket, including the empty ones", async () => {
    await raise({
      service: "checkout",
      title: "Payment errors above 20 percent",
      severity: "critical",
    });
    // Repeats of an open incident collapse into it, which is the whole point of the trace: one
    // broken thing is one phone call, and the storm behind it is still visible.
    await raise({
      service: "checkout",
      title: "Payment errors above 20 percent",
      severity: "critical",
    });

    const board = await bodyOf<BoardView>(await api("/api/audit/board"));
    const arrivals = board.focus?.arrivals ?? [];
    expect(arrivals).toHaveLength(10);
    expect(arrivals.reduce((sum, one) => sum + one.alerts, 0)).toBe(2);
    expect(board.focus?.repeats).toBe(1);
  });
});

describe("laying arrivals into buckets", () => {
  const now = new Date("2026-08-24T14:04:50.000Z");
  const width = ARRIVAL_BUCKET_MINUTES * 60_000;
  const ago = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();

  it("puts each arrival in the window it happened in", () => {
    const buckets = bucketArrivals([ago(1), ago(2), ago(23)], now);
    expect(buckets).toHaveLength(10);
    expect(buckets[buckets.length - 1]?.alerts).toBe(2);
    expect(buckets.reduce((sum, one) => sum + one.alerts, 0)).toBe(3);
  });

  /**
   * Anchored to the bucket boundary rather than to the moment of the read, or the trace shuffles
   * sideways every time the board polls, which on a two second poll is a chart that never sits still.
   */
  it("draws the same picture twice inside one bucket", () => {
    const arrivals = [ago(1), ago(12)];
    const later = new Date(now.getTime() + 1000);
    expect(bucketArrivals(arrivals, later)).toEqual(
      bucketArrivals(arrivals, now),
    );
  });

  it("keeps the empty buckets, so a quiet hour is not drawn as a busy one", () => {
    const buckets = bucketArrivals([], now);
    expect(buckets).toHaveLength(10);
    expect(buckets.every((one) => one.alerts === 0)).toBe(true);
    // Oldest first, one bucket apart.
    const first = Date.parse(buckets[0]?.at ?? "");
    const second = Date.parse(buckets[1]?.at ?? "");
    expect(second - first).toBe(width);
  });

  it("drops what it cannot place rather than putting it somewhere wrong", () => {
    const buckets = bucketArrivals(["not a date", ago(9999), ago(3)], now);
    expect(buckets.reduce((sum, one) => sum + one.alerts, 0)).toBe(1);
  });
});

/**
 * The transcript arrived from a third party, went through JSON, and is drawn as somebody's words on
 * a screen. Every turn is checked on the way out rather than trusted.
 */
describe("reading a stored transcript back", () => {
  it("keeps the turns it can read", () => {
    expect(
      readTranscript([
        { offsetSeconds: 4, speaker: "user", text: "Roll it back." },
      ]),
    ).toEqual([{ offsetSeconds: 4, speaker: "user", text: "Roll it back." }]);
  });

  /**
   * An unattributed turn is the machine's own guess about who was speaking, and the authorization
   * gate refuses to treat one as the responder. The screen has to agree with it.
   */
  it("calls an unrecognised speaker unknown rather than inventing one", () => {
    expect(
      readTranscript([{ offsetSeconds: 0, speaker: "agent", text: "hello" }]),
    ).toEqual([{ offsetSeconds: 0, speaker: "unknown", text: "hello" }]);
  });

  it("drops a turn whose words are not words", () => {
    expect(
      readTranscript([
        { speaker: "user", text: { was: "an object" } },
        null,
        "a string",
        { speaker: "user", text: "kept" },
      ]),
    ).toEqual([{ offsetSeconds: null, speaker: "user", text: "kept" }]);
  });

  it("has nothing to say about something that is not a transcript", () => {
    expect(readTranscript(null)).toEqual([]);
    expect(readTranscript({ turns: [] })).toEqual([]);
  });
});
