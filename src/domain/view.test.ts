import { describe, expect, it } from "vitest";
import viewSource from "./view.ts?raw";
import {
  asClock,
  elapsedFraction,
  incidentStates,
  labelForState,
  normalisePhrase,
  openIncidentStates,
  phrasesMatch,
  severityAtLeast,
  sinceWords,
  toneForState,
  turnGranting,
  verifiedFlag,
} from "./view.js";

describe("the contract both halves of the product read", () => {
  /**
   * The one rule that makes this module safe to hand the browser. `.dependency-cruiser.cjs` lets
   * `src/ui` import this file and nothing else under `src/`, so an import added here would carry
   * whatever it named straight into the bundle, past a boundary that would still report clean.
   */
  it("imports nothing at all", () => {
    const imports = viewSource.match(/^\s*import\s/gm) ?? [];
    expect(imports).toEqual([]);
    expect(viewSource).not.toMatch(/\brequire\s*\(/);
  });

  it("has a colour and a name for every state, with no state left out", () => {
    for (const state of incidentStates) {
      expect(toneForState(state)).toBeTruthy();
      expect(labelForState(state)).toMatch(/^[A-Z ]+$/);
    }
    expect(new Set(incidentStates).size).toBe(incidentStates.length);
  });

  it("counts an incident as open only while it can still lead to a call", () => {
    for (const state of openIncidentStates) {
      expect(incidentStates).toContain(state);
    }
    expect(openIncidentStates).not.toContain("resolved");
    expect(openIncidentStates).not.toContain("failed");
  });

  it("orders severities most serious first", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("low", "high")).toBe(false);
  });

  describe("the clock the ring counts on", () => {
    it("reads minutes and seconds, and hours once there are any", () => {
      expect(asClock(0)).toBe("00:00");
      expect(asClock(41)).toBe("00:41");
      expect(asClock(600)).toBe("10:00");
      expect(asClock(3661)).toBe("01:01:01");
    });

    /** A negative duration on screen reads as a bug in Ringbolt, not as a clock disagreeing. */
    it("never counts backwards", () => {
      expect(asClock(-5)).toBe("00:00");
    });
  });

  describe("how far through its own deadline something is", () => {
    const from = "2026-08-24T14:00:00.000Z";
    const to = "2026-08-24T14:10:00.000Z";
    const at = (iso: string) => Date.parse(iso);

    it("runs from nothing to full across the window", () => {
      expect(elapsedFraction(from, to, at("2026-08-24T14:00:00.000Z"))).toBe(0);
      expect(elapsedFraction(from, to, at("2026-08-24T14:05:00.000Z"))).toBe(
        0.5,
      );
    });

    /** An overrun is not extra time: the track is a picture of how much is left. */
    it("stops at full rather than reporting more than full", () => {
      expect(elapsedFraction(from, to, at("2026-08-24T14:40:00.000Z"))).toBe(1);
    });

    it("has no answer when there is no deadline to run against", () => {
      expect(elapsedFraction(from, null, at(to))).toBeNull();
      expect(elapsedFraction(null, to, at(to))).toBeNull();
      expect(elapsedFraction("not a date", to, at(to))).toBeNull();
      // A window that ends before it starts is a clock disagreeing, not a deadline.
      expect(elapsedFraction(to, from, at(to))).toBeNull();
    });
  });

  describe("how long ago something happened", () => {
    const now = Date.parse("2026-08-24T14:00:00.000Z");
    const ago = (seconds: number) =>
      sinceWords(new Date(now - seconds * 1000).toISOString(), now);

    it("uses the words a person would use", () => {
      expect(ago(10)).toBe("just now");
      expect(ago(300)).toBe("5 min ago");
      expect(ago(3600 * 3)).toBe("3 hours ago");
      expect(ago(3600 * 48)).toBe("2 days ago");
    });

    /** A monitor's clock ahead of ours is ordinary. It must not print a negative age. */
    it("reads a future timestamp as just now", () => {
      expect(sinceWords(new Date(now + 60_000).toISOString(), now)).toBe(
        "just now",
      );
    });

    it("has no answer for something that never happened", () => {
      expect(sinceWords(null, now)).toBeNull();
      expect(sinceWords("not a date", now)).toBeNull();
    });
  });

  /**
   * The gate and the screen match a spoken phrase the same way, because a screen that highlighted a
   * turn the gate would not have accepted would be showing evidence for a decision made on
   * something else.
   */
  describe("matching what somebody said", () => {
    it("ignores punctuation, casing and spacing", () => {
      expect(phrasesMatch("Roll it back.", "roll it back")).toBe(true);
      expect(phrasesMatch("  ROLL  IT   BACK  ", "roll it back")).toBe(true);
    });

    it("still needs the right words in the right order", () => {
      expect(phrasesMatch("back it roll", "roll it back")).toBe(false);
      expect(phrasesMatch("roll it", "roll it back")).toBe(false);
    });

    it("normalises to words and nothing else", () => {
      expect(normalisePhrase("Roll -- it back!")).toBe("roll it back");
      expect(normalisePhrase("   ")).toBe("");
    });
  });

  /**
   * The gate's third question and the deck's red tie both come from this search, so its boundaries
   * are product claims: the turn it returns is presented as the moment permission was granted.
   */
  describe("which turn granted permission", () => {
    it("finds the words inside a sentence, and the last saying of them wins", () => {
      const index = turnGranting(
        [
          { speaker: "assistant", text: "Say roll it back to confirm." },
          { speaker: "user", text: "So I would say roll it back?" },
          { speaker: "user", text: "Yes. Roll it back, please." },
        ],
        "roll it back",
      );
      expect(index).toBe(2);
    });

    /** A responder can answer before Ringbolt says a word, and the search must reach that turn. */
    it("finds a phrase carried by the very first turn", () => {
      expect(
        turnGranting(
          [{ speaker: "user", text: "Roll it back." }],
          "roll it back",
        ),
      ).toBe(0);
    });

    it("marks nothing for words only Ringbolt said", () => {
      expect(
        turnGranting(
          [{ speaker: "assistant", text: "Roll it back." }],
          "roll it back",
        ),
      ).toBeNull();
    });

    /**
     * A phrase that normalises to nothing is contained in every sentence, so without this rule the
     * last thing the responder said, whatever it was, would be marked as the authorization.
     */
    it("marks nothing when the required phrase has no words in it", () => {
      const spoken = [{ speaker: "user", text: "Go ahead." }];
      expect(turnGranting(spoken, "")).toBeNull();
      expect(turnGranting(spoken, " -- !!")).toBeNull();
    });

    const saying = (text: string) => [{ speaker: "user", text }];

    /**
     * The defect this search had until it read words. It tested characters in the joined string,
     * so a responder refusing the action counted as saying the words that authorize it.
     */
    it.each([
      "Do not roll it back.",
      "Never roll it back.",
      "Dont roll it back",
      // `normalisePhrase` turns the apostrophe into a space, so each of these arrives as a stem
      // ending in n and then a lone t. A list of negating words alone would miss every one.
      "Don't roll it back.",
      "Please don't roll it back.",
      "We can't roll it back.",
      "Don't just roll it back.",
    ])("marks nothing when the words are said negated: %s", (text) => {
      expect(turnGranting(saying(text), "roll it back")).toBeNull();
    });

    /** The characters of the phrase inside other words are not the phrase. */
    it.each(["Unroll it backwards.", "Roll it backup."])(
      "marks nothing when the words only appear inside other words: %s",
      (text) => {
        expect(turnGranting(saying(text), "roll it back")).toBeNull();
      },
    );

    /**
     * The last saying wins in both directions. A responder who said the words and then withdrew
     * them finished on a refusal, so the earlier plain saying must not be reached for instead.
     */
    it("marks nothing when a later turn withdraws the words", () => {
      expect(
        turnGranting(
          [
            { speaker: "user", text: "Roll it back." },
            { speaker: "user", text: "Actually, do not roll it back." },
          ],
          "roll it back",
        ),
      ).toBeNull();
    });

    it("marks nothing when the words are withdrawn inside the same turn", () => {
      expect(
        turnGranting(
          saying("Roll it back, no wait, do not roll it back."),
          "roll it back",
        ),
      ).toBeNull();
    });

    it("grants on a plain saying that comes after a refusal", () => {
      expect(
        turnGranting(
          [
            { speaker: "user", text: "Do not roll it back yet." },
            { speaker: "user", text: "Okay, roll it back now." },
          ],
          "roll it back",
        ),
      ).toBe(1);
      expect(
        turnGranting(
          saying("Do not roll it back yet, actually roll it back."),
          "roll it back",
        ),
      ).toBe(0);
    });

    /**
     * Left out of the negating words on purpose, because refusing these throws away a real
     * authorization. "No" here contradicts something before it and then agrees, and "can we"
     * asks for the action.
     */
    it.each(["No, roll it back.", "Can we roll it back?"])(
      "still grants on a saying that only looks negative: %s",
      (text) => {
        expect(turnGranting(saying(text), "roll it back")).toBe(0);
      },
    );

    /**
     * The negation is read from the three words in front of the phrase, and both edges of that are
     * pinned here so a change to them is a decision rather than an accident. A word count cannot
     * tell which clause a negation belongs to, so there is no width that gets both of these right.
     *
     * Too far back to see: this is a refusal, and it is not caught. It needs the provider's
     * extraction to have already turned a refusal into `run_action` with the exact phrase, which
     * is the failure this check exists to notice, so it is a real gap and is named as one.
     */
    it("does not reach a negation more than three words before the phrase", () => {
      expect(
        turnGranting(
          saying("I don't want you to roll it back."),
          "roll it back",
        ),
      ).toBe(0);
    });

    /**
     * Close enough to see, but belonging to another clause: this is an authorization, and it is
     * refused. That is the accepted cost of the width. A refusal here escalates to the next person
     * on the rota, where the opposite error is a production change made on somebody saying not to.
     */
    it("refuses a saying with an unrelated negation in the three words before it", () => {
      expect(
        turnGranting(
          saying("I didn't catch that, roll it back."),
          "roll it back",
        ),
      ).toBeNull();
    });
  });

  /**
   * Nobody looked is a third answer, not a false. An action recorded as unverified is one nobody
   * checked, and drawing that as "did not work" is a different claim from the one the record makes.
   */
  describe("whether the check afterwards found what it expected", () => {
    it("reads a real verdict", () => {
      expect(verifiedFlag({ verified: true })).toBe(true);
      expect(verifiedFlag({ verified: false })).toBe(false);
    });

    it("says nobody looked when there is nothing to read", () => {
      expect(verifiedFlag(null)).toBeNull();
      expect(verifiedFlag(undefined)).toBeNull();
      expect(verifiedFlag({})).toBeNull();
      expect(verifiedFlag({ verified: "yes" })).toBeNull();
      expect(verifiedFlag("verified")).toBeNull();
    });
  });
});
