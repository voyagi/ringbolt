import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  alertPayload,
  canTransition,
  describeForSpeech,
  fingerprintFor,
  incidentStates,
  isTerminal,
  openIncidentStates,
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

  it("lets a snooze lead back to another call", () => {
    expect(canTransition("deciding", "snoozed")).toBe(true);
    expect(canTransition("snoozed", "calling")).toBe(true);
  });

  /**
   * A state that is open to the duplicate check but not to the database index, or the other way
   * round, is a second phone call nobody asked for. This is the pairing that keeps the two honest.
   */
  it("counts every non-terminal state as open", () => {
    expect([...openIncidentStates].sort()).toEqual(
      incidentStates.filter((state) => !isTerminal(state)).sort(),
    );
  });
});

describe("describeForSpeech", () => {
  const incident = {
    service: "checkout",
    title: "Payment errors above 20 percent",
    severity: "critical" as const,
    detail: null,
    startedAt: "2026-08-21T14:00:00.000Z",
  };

  it("says how long the problem has been running rather than a timestamp", () => {
    const spoken = describeForSpeech(
      incident,
      new Date("2026-08-21T14:18:00.000Z"),
    );
    expect(spoken).toContain("Started 18 minutes ago.");
    expect(spoken).not.toContain("2026-08-21T14:00:00.000Z");
  });

  it("rounds a long-running problem to hours", () => {
    expect(
      describeForSpeech(incident, new Date("2026-08-21T17:00:00.000Z")),
    ).toContain("Started 3 hours ago.");
  });

  it("says nothing about timing when the monitor sent none", () => {
    expect(
      describeForSpeech({ ...incident, startedAt: null }, new Date()),
    ).not.toContain("Started");
  });

  it("does not report a negative age when the sender's clock runs fast", () => {
    expect(
      describeForSpeech(incident, new Date("2026-08-21T13:50:00.000Z")),
    ).toContain("Started just now.");
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
