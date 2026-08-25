import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONFIDENCE_FLOOR, authorize } from "./decision.js";

/**
 * The example tests beside this one pin the cases that were reasoned about. These pin the rules
 * that have to hold for every input, including the ones nobody thought of, which is the half an
 * example suite cannot reach: an authorization gate is a claim about ALL calls, not about six.
 */
const REQUIRED = "roll it back";

const offered = [
  { id: "kill_switch" },
  { id: "rollback", confirmationPhrase: REQUIRED, minConfidence: 0.9 },
];

/**
 * The same reduction to words the gate does, written out here rather than imported from it. A
 * property that built its inputs with the function under test would agree with it by construction.
 */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const speaker = fc.constantFrom("bot", "user", "unknown");

/** Any transcript in which the responder was never heard: no user turn with words in it. */
const unheard = fc
  .array(
    fc.record({
      speaker,
      text: fc.oneof(
        fc.constant(""),
        fc.stringMatching(/^[ \t]{1,5}$/),
        fc.string(),
      ),
    }),
    { maxLength: 8 },
  )
  .map((turns) =>
    turns.map((turn) =>
      turn.speaker === "user" ? { ...turn, text: blankOf(turn.text) } : turn,
    ),
  );

/** Keeps the generated length while guaranteeing there is nothing in it to hear. */
function blankOf(text: string): string {
  return " ".repeat(Math.min(text.length, 5));
}

/**
 * Any transcript with something in it the responder actually said. Half of them carry the words the
 * confirmed action demands: a generator that never said them would only ever exercise the action
 * that needs no confirmation, and the property below is about what gets through.
 */
const heard = fc.oneof(
  fc
    .string({ minLength: 1 })
    .filter((text) => text.trim() !== "")
    .map((text) => [{ speaker: "user", text }]),
  fc
    .string()
    .map((text) => [{ speaker: "user", text: `${text} roll it back` }]),
);

/** Heard, and provably not carrying the phrase, whatever the generator produced. */
const heardWithoutThePhrase = fc
  .string({ minLength: 1 })
  .filter((text) => text.trim() !== "")
  .filter((text) => !words(text).includes(REQUIRED))
  .map((text) => [{ speaker: "user", text }]);

const decision = fc.record(
  {
    decision: fc.constantFrom("run_action", "hold", "escalate", "snooze"),
    action_id: fc.constantFrom("kill_switch", "rollback", "wipe_everything"),
    confirmation_phrase: fc.string(),
    snooze_minutes: fc.integer({ min: 1, max: 1440 }),
  },
  { requiredKeys: ["decision"] },
);

const confidence = fc.double({ min: 0, max: 1, noNaN: true });

describe("what the authorization gate guarantees for every call", () => {
  it("never authorizes anything on a call the responder was not heard on", () => {
    fc.assert(
      fc.property(
        unheard,
        decision,
        confidence,
        (transcript, spoken, score) => {
          const result = authorize({
            callStatus: "completed",
            taskCompleted: true,
            confidenceScore: score,
            structuredResult: spoken,
            transcript,
            offered,
          });
          expect(result.authorized).toBe(false);
        },
      ),
    );
  });

  /**
   * The one that matters most: whatever gets through, it got through as the action the responder
   * named, taken from the list that was read out, above the floor. Everything else is a refusal.
   */
  it("only ever authorizes an offered action the responder asked for", () => {
    let authorized = 0;
    fc.assert(
      fc.property(heard, decision, confidence, (transcript, spoken, score) => {
        const result = authorize({
          callStatus: "completed",
          taskCompleted: true,
          confidenceScore: score,
          structuredResult: spoken,
          transcript,
          offered,
        });
        if (!result.authorized) return;
        authorized += 1;

        expect(result.decision.decision).toBe("run_action");
        expect(result.action.id).toBe(spoken.action_id);
        expect(offered).toContain(result.action);
        expect(score).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
        expect(score).toBeGreaterThanOrEqual(result.action.minConfidence ?? 0);
      }),
      // The seed is pinned on this one property, and only this one. It is the only property here
      // that asserts something about the cases that PASS, so an unlucky seed that generated none
      // would fail it for no reason at all, and a test that fails one run in ten teaches everybody
      // to ignore it. The refusal properties above hold for every input and stay unseeded.
      { seed: 20260824, numRuns: 500 },
    );

    // A property about what gets through proves nothing if nothing ever does. A gate that refused
    // everything would satisfy the assertions above perfectly.
    expect(authorized).toBeGreaterThan(0);
  });

  /**
   * Speech to text loses punctuation and casing, so the phrase check is deliberately loose about
   * both. It is not loose about the words: a confirmation nobody said cannot be constructed out of
   * whatever the transcription happened to hear.
   */
  it("never accepts a confirmation phrase whose words are not the required ones", () => {
    fc.assert(
      fc.property(
        heard,
        fc.string(),
        confidence,
        (transcript, phrase, score) => {
          fc.pre(words(phrase) !== REQUIRED);

          const result = authorize({
            callStatus: "completed",
            taskCompleted: true,
            confidenceScore: score,
            structuredResult: {
              decision: "run_action",
              action_id: "rollback",
              confirmation_phrase: phrase,
            },
            transcript,
            offered,
          });
          expect(result.authorized).toBe(false);
        },
      ),
    );
  });

  /**
   * The other half of that rule, and the one that was missing until 2026-08-25: the phrase matching
   * what the action demanded says the provider extracted those words, never that anybody said them.
   * A confidence above the action's own floor is generated on purpose, so the refusal being asserted
   * is this one rather than a cheaper check firing first.
   */
  it("never runs a confirmed action on words nobody is recorded saying", () => {
    fc.assert(
      fc.property(
        heardWithoutThePhrase,
        fc.double({ min: 0.9, max: 1, noNaN: true }),
        (transcript, score) => {
          const result = authorize({
            callStatus: "completed",
            taskCompleted: true,
            confidenceScore: score,
            structuredResult: {
              decision: "run_action",
              action_id: "rollback",
              confirmation_phrase: REQUIRED,
            },
            transcript,
            offered,
          });
          expect(result).toMatchObject({
            authorized: false,
            refusal: "confirmation_not_in_transcript",
          });
        },
      ),
    );
  });

  it("never authorizes a call that did not complete, whatever else is true of it", () => {
    fc.assert(
      fc.property(
        heard,
        decision,
        confidence,
        fc.constantFrom("queued", "in_progress", "failed", "canceled"),
        (transcript, spoken, score, status) => {
          const result = authorize({
            callStatus: status,
            taskCompleted: true,
            confidenceScore: score,
            structuredResult: spoken,
            transcript,
            offered,
          });
          expect(result).toMatchObject({
            authorized: false,
            refusal: "call_not_completed",
          });
        },
      ),
    );
  });
});
