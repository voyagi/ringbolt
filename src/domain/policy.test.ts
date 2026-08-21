import { describe, expect, it } from "vitest";
import type { Severity } from "./incident.js";
import {
  type QuietHours,
  type ServicePolicy,
  defaultPolicy,
  quietHoursHold,
  quietHoursInput,
  routeAlert,
  servicePolicyInput,
} from "./policy.js";

const ALL_ACTIONS = ["kill_switch", "rollback"];

function policyWith(overrides: Partial<ServicePolicy> = {}): ServicePolicy {
  return {
    ...defaultPolicy("checkout", ALL_ACTIONS, "2026-08-21T12:00:00.000Z"),
    ...overrides,
  };
}

/** Overnight in the Netherlands, which is UTC+2 in August. */
const overnight: QuietHours = {
  startMinute: 22 * 60,
  endMinute: 7 * 60,
  zone: "Europe/Amsterdam",
  minSeverity: "critical",
};

const atHalfPastOneLocal = new Date("2026-08-21T23:30:00.000Z");
const atMiddayLocal = new Date("2026-08-21T10:00:00.000Z");

describe("the default policy", () => {
  /**
   * The only default an on-call tool is allowed to have. An install that has configured nothing
   * still telephones somebody, because the alternative is a product that looks like it is watching
   * and is not.
   */
  it("calls about everything until somebody says otherwise", () => {
    const policy = defaultPolicy("checkout", ALL_ACTIONS, "now");
    expect(routeAlert(routing(policy, "low"))).toEqual({ kind: "call" });
    expect(policy.quietHours).toBeNull();
    expect(policy.allowedActions).toEqual(ALL_ACTIONS);
  });
});

describe("what a severity threshold does", () => {
  it("records an alert below the threshold and telephones nobody", () => {
    const policy = policyWith({ minSeverity: "high" });
    expect(routeAlert(routing(policy, "low"))).toEqual({ kind: "filter" });
  });

  it("calls at the threshold and above", () => {
    const policy = policyWith({ minSeverity: "high" });
    expect(routeAlert(routing(policy, "high"))).toEqual({ kind: "call" });
    expect(routeAlert(routing(policy, "critical"))).toEqual({ kind: "call" });
  });
});

describe("quiet hours", () => {
  it("holds a lesser alert until the window ends", () => {
    const held = quietHoursHold(overnight, "high", atHalfPastOneLocal);
    // Half past one in the morning locally, and the window runs to seven, so five and a half hours.
    expect(held?.toISOString()).toBe("2026-08-22T05:00:00.000Z");
  });

  it("lets the severity that was allowed to break the window through", () => {
    expect(
      quietHoursHold(overnight, "critical", atHalfPastOneLocal),
    ).toBeNull();
  });

  it("does nothing outside the window", () => {
    expect(quietHoursHold(overnight, "low", atMiddayLocal)).toBeNull();
  });

  /**
   * A window that does not wrap past midnight, which is the other half of the arithmetic and the
   * half that a naive start-to-end comparison gets right by accident.
   */
  it("handles a window inside one day", () => {
    const lunch: QuietHours = {
      startMinute: 12 * 60,
      endMinute: 13 * 60,
      zone: "UTC",
      minSeverity: "critical",
    };
    expect(
      quietHoursHold(
        lunch,
        "low",
        new Date("2026-08-21T12:15:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-08-21T13:00:00.000Z");
    expect(
      quietHoursHold(lunch, "low", new Date("2026-08-21T13:00:00.000Z")),
    ).toBeNull();
  });

  /**
   * Every uncertainty in this function resolves towards ringing the telephone. A zone the runtime
   * cannot resolve is a configuration mistake, and the wrong way to fail on one is silence.
   */
  it("rings rather than holds when the zone cannot be resolved", () => {
    const broken = { ...overnight, zone: "Nowhere/Imaginary" };
    expect(quietHoursHold(broken, "low", atHalfPastOneLocal)).toBeNull();
  });

  it("refuses to store a zone the runtime cannot resolve", () => {
    expect(
      quietHoursInput.safeParse({ ...overnight, zone: "Nowhere/Imaginary" })
        .success,
    ).toBe(false);
    expect(quietHoursInput.safeParse(overnight).success).toBe(true);
  });

  it("refuses a window with no width", () => {
    expect(
      quietHoursInput.safeParse({
        ...overnight,
        startMinute: 300,
        endMinute: 300,
      }).success,
    ).toBe(false);
  });
});

describe("flap suppression", () => {
  const policy = policyWith({ flapWindowMinutes: 15, maxCallsPerWindow: 1 });
  const now = new Date("2026-08-21T12:00:00.000Z");

  it("calls when the window is empty", () => {
    expect(
      routeAlert({
        policy,
        severity: "high",
        now,
        recentCalls: 0,
        windowOpenedAt: null,
      }),
    ).toEqual({ kind: "call" });
  });

  /**
   * The window rolls from the earliest call inside it, not from now, so a service that flaps every
   * thirty seconds does not push its own suppression out for ever.
   */
  it("suppresses a repeat until the window rolls off the first call", () => {
    const routed = routeAlert({
      policy,
      severity: "high",
      now,
      recentCalls: 1,
      windowOpenedAt: new Date("2026-08-21T11:56:00.000Z"),
    });
    expect(routed).toEqual({
      kind: "mute",
      until: new Date("2026-08-21T12:11:00.000Z"),
    });
  });

  it("lets a service that allows more calls through", () => {
    const chatty = policyWith({ maxCallsPerWindow: 3 });
    expect(
      routeAlert({
        policy: chatty,
        severity: "high",
        now,
        recentCalls: 2,
        windowOpenedAt: new Date("2026-08-21T11:56:00.000Z"),
      }),
    ).toEqual({ kind: "call" });
  });
});

describe("the order the rules are applied in", () => {
  const now = atHalfPastOneLocal;

  /**
   * A severity below the threshold is not worth a call at all, so it never reaches the window and
   * never occupies a suppression slot that a real call should have had.
   */
  it("puts the severity threshold before everything", () => {
    const policy = policyWith({
      minSeverity: "critical",
      quietHours: overnight,
    });
    expect(
      routeAlert({
        policy,
        severity: "low",
        now,
        recentCalls: 5,
        windowOpenedAt: new Date(now.getTime() - 60_000),
      }),
    ).toEqual({ kind: "filter" });
  });

  /**
   * Suppression is the stronger statement of the two: quiet hours only say "not now", while
   * suppression says this exact problem already rang a phone. Deferring instead would mean calling
   * about it in the morning anyway.
   */
  it("puts suppression before quiet hours", () => {
    const policy = policyWith({ quietHours: overnight });
    const routed = routeAlert({
      policy,
      severity: "high",
      now,
      recentCalls: 1,
      windowOpenedAt: new Date("2026-08-21T23:20:00.000Z"),
    });
    expect(routed.kind).toBe("mute");
  });

  it("defers when quiet hours are the only thing in the way", () => {
    const policy = policyWith({ quietHours: overnight });
    expect(routeAlert(routing(policy, "high", now)).kind).toBe("defer");
  });
});

describe("what a policy may be set to", () => {
  const valid = {
    minSeverity: "high",
    quietHours: null,
    allowedActions: ["kill_switch"],
    flapWindowMinutes: 15,
    maxCallsPerWindow: 1,
    escalateAfterMinutes: 3,
  };

  it("accepts a policy that names everything", () => {
    expect(servicePolicyInput.safeParse(valid).success).toBe(true);
  });

  /**
   * Zero would be a service that can never be called about and never wakes up either, which is a
   * telephone silenced by a number rather than by a decision anybody can see on a screen.
   */
  it("refuses a service that could never be called about", () => {
    expect(
      servicePolicyInput.safeParse({ ...valid, maxCallsPerWindow: 0 }).success,
    ).toBe(false);
  });

  it("refuses a suppression window with no width", () => {
    expect(
      servicePolicyInput.safeParse({ ...valid, flapWindowMinutes: 0 }).success,
    ).toBe(false);
  });

  it("defaults quiet hours to none rather than demanding them", () => {
    const { quietHours: _absent, ...withoutQuietHours } = valid;
    const parsed = servicePolicyInput.safeParse(withoutQuietHours);
    expect(parsed.success && parsed.data.quietHours).toBeNull();
  });
});

function routing(
  policy: ServicePolicy,
  severity: Severity,
  now = new Date("2026-08-21T12:00:00.000Z"),
) {
  return { policy, severity, now, recentCalls: 0, windowOpenedAt: null };
}
