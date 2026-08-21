import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  alertPayload,
  canTransition,
  fingerprintFor,
  incidentStates,
  isTerminal,
  transition,
} from "./incident.js";

describe("incident state machine", () => {
  it("walks the happy path", () => {
    let state = transition("received", "calling");
    state = transition(state, "deciding");
    state = transition(state, "acting");
    state = transition(state, "resolved");
    expect(state).toBe("resolved");
  });

  it("refuses to skip the call", () => {
    expect(() => transition("received", "acting")).toThrow(
      InvalidTransitionError,
    );
  });

  it("refuses to act on a decision that was never made", () => {
    expect(() => transition("calling", "acting")).toThrow(
      InvalidTransitionError,
    );
  });

  it("cannot leave a terminal state", () => {
    for (const state of incidentStates.filter(isTerminal)) {
      for (const target of incidentStates) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it("treats resolved, held and failed as the only terminal states", () => {
    expect(incidentStates.filter(isTerminal).sort()).toEqual([
      "failed",
      "held",
      "resolved",
    ]);
  });

  it("allows escalation back into another call", () => {
    expect(canTransition("escalating", "calling")).toBe(true);
  });
});

describe("fingerprintFor", () => {
  it("uses the sender's fingerprint when there is one", () => {
    const alert = alertPayload.parse({
      service: "checkout",
      title: "5xx spike",
      fingerprint: "abc",
    });
    expect(fingerprintFor(alert)).toBe("abc");
  });

  it("falls back to service and title so repeats collapse", () => {
    const first = alertPayload.parse({
      service: "checkout",
      title: "5xx spike",
    });
    const second = alertPayload.parse({
      service: "checkout",
      title: "5xx spike",
      detail: "now worse",
    });
    expect(fingerprintFor(first)).toBe(fingerprintFor(second));
  });

  it("keeps different services apart even with the same title", () => {
    const a = alertPayload.parse({ service: "checkout", title: "5xx spike" });
    const b = alertPayload.parse({ service: "search", title: "5xx spike" });
    expect(fingerprintFor(a)).not.toBe(fingerprintFor(b));
  });
});

describe("alertPayload", () => {
  it("defaults severity rather than rejecting an alert that omits it", () => {
    expect(
      alertPayload.parse({ service: "checkout", title: "down" }).severity,
    ).toBe("high");
  });

  it("rejects an alert with no service", () => {
    expect(alertPayload.safeParse({ title: "down" }).success).toBe(false);
  });

  it("rejects a link that is not a url", () => {
    const result = alertPayload.safeParse({
      service: "checkout",
      title: "down",
      links: [{ label: "dashboard", url: "not a url" }],
    });
    expect(result.success).toBe(false);
  });
});
