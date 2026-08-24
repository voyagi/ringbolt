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
