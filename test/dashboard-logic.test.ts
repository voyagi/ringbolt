import { describe, expect, it } from "vitest";
import type { IncidentView, TranscriptTurnView } from "../src/domain/view.js";
import {
  grantingTurn,
  runsByCall,
  spokenPhrase,
  turnSpans,
} from "../src/ui/parts/call.js";
import { parseRoute } from "../src/ui/router.js";
import { nothingYet } from "../src/ui/screens/deck.js";

/**
 * The parts of the dashboard that DECIDE something, as opposed to the parts that draw. Rendering is
 * covered by `npm run a11y:live`, which drives a real browser over every screen in both themes; this
 * file is for the handful of functions where being wrong would put a false claim on the screen.
 */

const say = (
  speaker: TranscriptTurnView["speaker"],
  text: string,
  offsetSeconds: number | null = null,
): TranscriptTurnView => ({ speaker, text, offsetSeconds });

describe("which sentence authorized an action", () => {
  const transcript = [
    say("bot", "Payment errors are at twenty three percent.", 0),
    say("user", "Is anything else touching payments?", 11),
    say("bot", "No, search and accounts are clean.", 14),
    say("user", "Right. Roll it back.", 19),
  ];

  it("marks the turn carrying the words the action required", () => {
    expect(grantingTurn(transcript, "roll it back")).toBe(3);
  });

  /**
   * The whole point. A screen that pointed at the last thing somebody said and called it the
   * authorization would be guessing, and this product refuses to act on a guess about what somebody
   * said. It must not draw one either.
   */
  it("marks nothing when no turn carries them", () => {
    expect(grantingTurn(transcript, "turn it off")).toBeNull();
    expect(grantingTurn(transcript, null)).toBeNull();
    expect(grantingTurn(transcript, "   ")).toBeNull();
    expect(grantingTurn([], "roll it back")).toBeNull();
  });

  /** Ringbolt reading the phrase out is not the responder saying it back. */
  it("never marks a turn Ringbolt spoke", () => {
    const readOut = [
      say("bot", "Say roll it back to confirm.", 0),
      say("unknown", "roll it back", 3),
    ];
    expect(grantingTurn(readOut, "roll it back")).toBeNull();
  });

  it("matches the way the authorization gate matches, not letter by letter", () => {
    expect(
      grantingTurn([say("user", "ROLL  IT  BACK!", 0)], "roll it back"),
    ).toBe(0);
  });

  it("takes the last such turn when the phrase was said twice", () => {
    const twice = [
      say("user", "roll it back", 5),
      say("bot", "Say it again to confirm.", 7),
      say("user", "roll it back", 9),
    ];
    expect(grantingTurn(twice, "roll it back")).toBe(2);
  });

  it("reads the phrase off the decision, and nothing off a decision without one", () => {
    expect(
      spokenPhrase({
        id: "run_1",
        actionId: "rollback",
        authorizedBy: null,
        outcome: "succeeded",
        detail: null,
        attempts: 1,
        durationMs: null,
        verification: null,
        stateBefore: null,
        stateAfter: null,
        decision: { confirmation_phrase: "roll it back" },
        parameters: null,
        at: "2026-08-24T14:04:50.000Z",
      }),
    ).toBe("roll it back");
    expect(spokenPhrase(undefined)).toBeNull();
  });
});

describe("which call authorized which action", () => {
  const run = (id: string, at: string) => ({
    id,
    actionId: "rollback",
    authorizedBy: "Nadia",
    outcome: "succeeded" as const,
    detail: null,
    attempts: 1,
    durationMs: null,
    verification: null,
    stateBefore: null,
    stateAfter: null,
    decision: null,
    parameters: null,
    at,
  });

  /**
   * The failure this exists to stop: an unanswered first call and a second one that ended in a
   * rollback is two calls and one run, and pairing them by position hangs the rollback docket under
   * the call nobody picked up.
   */
  it("gives the run to the call that had ended before it, not to the first one", () => {
    const calls = [
      { recordedAt: "2026-08-24T15:59:00.000Z" },
      { recordedAt: "2026-08-24T16:04:17.000Z" },
    ];
    const byCall = runsByCall(calls, [
      run("run_1", "2026-08-24T16:04:20.000Z"),
    ]);
    expect(byCall[0]).toEqual([]);
    expect(byCall[1]?.map((one) => one.id)).toEqual(["run_1"]);
  });

  it("gives each call its own run when there are several", () => {
    const calls = [
      { recordedAt: "2026-08-24T10:00:00.000Z" },
      { recordedAt: "2026-08-24T12:00:00.000Z" },
    ];
    const byCall = runsByCall(calls, [
      run("run_1", "2026-08-24T10:00:05.000Z"),
      run("run_2", "2026-08-24T12:00:05.000Z"),
    ]);
    expect(byCall[0]?.map((one) => one.id)).toEqual(["run_1"]);
    expect(byCall[1]?.map((one) => one.id)).toEqual(["run_2"]);
  });

  /** A run with no call before it belongs to no call on the page rather than to the first one. */
  it("attaches nothing to a call that had not ended yet", () => {
    const calls = [{ recordedAt: "2026-08-24T16:00:00.000Z" }];
    expect(
      runsByCall(calls, [run("run_1", "2026-08-24T15:00:00.000Z")]),
    ).toEqual([[]]);
    expect(runsByCall(calls, [run("run_1", "not a date")])).toEqual([[]]);
  });
});

describe("laying the talk track out at real offsets", () => {
  it("runs each turn until the next one starts", () => {
    const spans = turnSpans([
      say("bot", "one", 0),
      say("user", "two", 12),
      say("bot", "three", 20),
    ]);
    expect(spans).toEqual([
      { start: 0, end: 12, speaker: "bot" },
      { start: 12, end: 20, speaker: "user" },
      { start: 20, end: 21, speaker: "bot" },
    ]);
  });

  /**
   * A missing offset is a gap in what CALL-E told us, not evidence that nobody spoke, so the turn
   * takes an equal share rather than collapsing to nothing.
   */
  it("gives a turn with no offset a share rather than no width", () => {
    const spans = turnSpans([say("bot", "one"), say("user", "two")]);
    expect(spans.every((span) => span.end > span.start)).toBe(true);
  });

  it("has nothing to draw for an empty transcript", () => {
    expect(turnSpans([])).toEqual([]);
  });
});

describe("why the centre of the deck is empty", () => {
  const focused = (
    state: IncidentView["state"],
    wakeReason: IncidentView["wakeReason"] = null,
  ): IncidentView => ({
    id: "inc_1",
    state,
    service: "dockside",
    title: "Payment errors above 20 percent",
    severity: "critical",
    detail: null,
    source: null,
    startedAt: null,
    links: [],
    offeredActions: [],
    wakeAt: null,
    wakeReason,
    callAttempts: 0,
    rotationPosition: 0,
    callStartedAt: null,
    createdAt: "2026-08-24T14:00:00.000Z",
    updatedAt: "2026-08-24T14:00:00.000Z",
    outcome: null,
    contactName: null,
  });

  /**
   * The focused incident is the most urgent thing open, and the most urgent thing open is often not
   * on the telephone at all. Saying the line is open on one that was never called is a sentence
   * about a call that is not happening, which is the class of false claim this product cannot make.
   */
  it("only says the line is open when it is", () => {
    expect(nothingYet(focused("calling"))).toContain("The line is open");
    expect(nothingYet(focused("deferred", "quiet_hours_over"))).toContain(
      "waiting",
    );
    expect(nothingYet(focused("received"))).toBe(
      "Nobody has been telephoned about this yet.",
    );
  });
});

describe("reading the address bar", () => {
  it("knows every screen", () => {
    expect(parseRoute("/")).toEqual({ name: "deck" });
    expect(parseRoute("/incidents")).toEqual({ name: "incidents" });
    expect(parseRoute("/incidents/inc_123")).toEqual({
      name: "incident",
      id: "inc_123",
    });
    expect(parseRoute("/runbooks")).toEqual({ name: "runbooks" });
    expect(parseRoute("/rota")).toEqual({ name: "rota" });
    expect(parseRoute("/demo")).toEqual({ name: "demo" });
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
  });

  it("tolerates the shapes a browser actually produces", () => {
    expect(parseRoute("")).toEqual({ name: "deck" });
    expect(parseRoute("/incidents/")).toEqual({ name: "incidents" });
  });

  /**
   * Anything else is a screen that does not exist, and saying so is better than drawing the deck at
   * an address that is not the deck.
   */
  it("names what it could not find rather than falling back to the deck", () => {
    expect(parseRoute("/nope")).toEqual({ name: "missing", path: "/nope" });
    expect(parseRoute("/incidents/inc_1/extra")).toEqual({
      name: "missing",
      path: "/incidents/inc_1/extra",
    });
  });
});
