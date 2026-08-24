import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Severity, severities, severityAtLeast } from "./incident.js";
import {
  type ServicePolicy,
  defaultPolicy,
  quietHoursHold,
  routeAlert,
} from "./policy.js";
import {
  type Contact,
  contactAt,
  effectiveRotation,
  nextInRotation,
} from "./rotation.js";

/**
 * The rules that decide whether a telephone rings at three in the morning, and who it rings, held
 * for every input rather than for the handful anybody thought to write down. Both of these are
 * failure-asymmetric: not ringing when it should is silence nobody notices until the morning, and
 * that is the direction these properties are pointed at.
 */
const severity = fc.constantFrom(...severities);
const minute = fc.integer({ min: 0, max: 1439 });
const zone = fc.constantFrom(
  "UTC",
  "Europe/Amsterdam",
  "America/New_York",
  "Asia/Tokyo",
);

const quietHours = fc
  .record({
    startMinute: minute,
    endMinute: minute,
    zone,
    minSeverity: severity,
  })
  .filter((window) => window.startMinute !== window.endMinute);

const policy = fc
  .record({
    minSeverity: severity,
    quietHours: fc.option(quietHours, { nil: null }),
    flapWindowMinutes: fc.integer({ min: 1, max: 1440 }),
    maxCallsPerWindow: fc.integer({ min: 1, max: 20 }),
    escalateAfterMinutes: fc.integer({ min: 1, max: 60 }),
  })
  .map((fields): ServicePolicy => ({
    ...defaultPolicy("checkout", ["kill_switch"], "2026-08-24T00:00:00.000Z"),
    ...fields,
  }));

const instant = fc
  .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) })
  .map((ms) => new Date(ms));

const contact = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  phone: fc.constant("+31612345678"),
  createdAt: fc.constant("2026-08-24T00:00:00.000Z"),
});

describe("what routing an alert guarantees", () => {
  it("never telephones anybody about an alert below the service's floor", () => {
    fc.assert(
      fc.property(
        policy,
        severity,
        instant,
        fc.nat({ max: 50 }),
        (servicePolicy, level, now, recentCalls) => {
          fc.pre(!severityAtLeast(level, servicePolicy.minSeverity));
          const routing = routeAlert({
            policy: servicePolicy,
            severity: level,
            now,
            recentCalls,
            windowOpenedAt: now,
          });
          expect(routing.kind).toBe("filter");
        },
      ),
    );
  });

  /**
   * Every parked outcome carries a time to come back at, and it is always ahead of now. A deadline
   * in the past is an incident that waits for a moment that has already gone, which on this product
   * means a call that never happens.
   */
  it("gives every parked alert a moment in the future to come back at", () => {
    let parked = 0;
    fc.assert(
      fc.property(
        policy,
        severity,
        instant,
        fc.nat({ max: 50 }),
        (servicePolicy, level, now, recentCalls) => {
          const routing = routeAlert({
            policy: servicePolicy,
            severity: level,
            now,
            recentCalls,
            windowOpenedAt: now,
          });
          if (routing.kind !== "defer" && routing.kind !== "mute") return;
          parked += 1;
          expect(routing.until.getTime()).toBeGreaterThan(now.getTime());
        },
      ),
      // Pinned for the same reason as the one in decision.properties.test.ts: this property is
      // about the cases that park, so a seed that happened to generate none would fail it.
      { seed: 20260824, numRuns: 500 },
    );
    expect(parked).toBeGreaterThan(0);
  });

  /**
   * Quiet hours are a delay for the things that can wait, never a filter. An alert at or above the
   * window's own floor rings through it, whatever the clock says.
   */
  it("never holds an alert that is serious enough to break the window", () => {
    fc.assert(
      fc.property(quietHours, severity, instant, (window, level, now) => {
        fc.pre(severityAtLeast(level, window.minSeverity));
        expect(quietHoursHold(window, level, now)).toBeNull();
      }),
    );
  });

  it("never holds anything for longer than the window can last", () => {
    fc.assert(
      fc.property(quietHours, severity, instant, (window, level, now) => {
        const held = quietHoursHold(window, level, now);
        if (held === null) return;
        const minutes = (held.getTime() - now.getTime()) / 60_000;
        expect(minutes).toBeGreaterThanOrEqual(0);
        expect(minutes).toBeLessThan(24 * 60);
      }),
    );
  });
});

describe("what the rotation guarantees", () => {
  it("always has somebody to call, even with no contacts at all", () => {
    fc.assert(
      fc.property(fc.array(contact, { maxLength: 5 }), (contacts) => {
        const rotation = effectiveRotation(
          contacts as Contact[],
          "+31600000000",
          "2026-08-24T00:00:00.000Z",
        );
        expect(rotation.length).toBeGreaterThan(0);
        expect(contactAt(rotation, 0)).not.toBeNull();
      }),
    );
  });

  /**
   * Escalation moves forward or stops. Handing an incident back to the person who has already been
   * called about it is the inversion this rules out for every rotation and every position, and it
   * is what makes "the next person" mean something.
   */
  it("never escalates to somebody at or before the current position", () => {
    fc.assert(
      fc.property(
        fc.array(contact, { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 10 }),
        (contacts, position) => {
          const rotation = contacts as Contact[];
          const next = nextInRotation(rotation, position);
          if (next === null) {
            expect(position + 1).toBeGreaterThanOrEqual(rotation.length);
            return;
          }
          expect(rotation.indexOf(next)).toBeGreaterThan(position);
        },
      ),
    );
  });

  it("runs out rather than wrapping round to the start", () => {
    fc.assert(
      fc.property(fc.array(contact, { minLength: 1, maxLength: 6 }), (list) => {
        const rotation = list as Contact[];
        expect(nextInRotation(rotation, rotation.length - 1)).toBeNull();
      }),
    );
  });
});

/** Guards the ordering the two above are written against. */
describe("severity", () => {
  it("orders from critical down to low", () => {
    const ordered: Severity[] = ["critical", "high", "low"];
    expect([...severities]).toEqual(ordered);
    expect(severityAtLeast("high", "low")).toBe(true);
    expect(severityAtLeast("low", "high")).toBe(false);
  });
});
