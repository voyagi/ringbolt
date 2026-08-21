import { z } from "zod";
import { type Severity, severities, severityAtLeast } from "./incident.js";

/**
 * How long the same problem is allowed to keep ringing a phone, and how often. One is the number
 * that makes the product's promise true: a service that flaps up and down all night is one call.
 */
export const DEFAULT_FLAP_WINDOW_MINUTES = 15;
export const DEFAULT_MAX_CALLS_PER_WINDOW = 1;

/** How long a placed call has to produce something before the next person is tried. */
export const DEFAULT_ESCALATE_AFTER_MINUTES = 3;

const MINUTES_IN_A_DAY = 24 * 60;

export type QuietHours = {
  /** Minutes from local midnight. A window whose end is before its start runs past midnight. */
  startMinute: number;
  endMinute: number;
  /** The IANA zone the two minute values are read in, for example Europe/Amsterdam. */
  zone: string;
  /** The severity that still rings during the window. Anything below it waits for the morning. */
  minSeverity: Severity;
};

export type ServicePolicy = {
  service: string;
  /** Below this, an alert is recorded and nobody is telephoned. */
  minSeverity: Severity;
  quietHours: QuietHours | null;
  /**
   * The action ids this service may put on a call. A stored policy lists them explicitly, so an
   * action added to the product later is not silently offered on services nobody has reviewed.
   */
  allowedActions: string[];
  flapWindowMinutes: number;
  maxCallsPerWindow: number;
  escalateAfterMinutes: number;
  updatedAt: string;
};

/**
 * A zone this runtime cannot resolve would make every quiet-hours check throw, so the write path
 * refuses one rather than letting it reach the check. Fails towards ringing: see quietHoursHold.
 */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const quietHoursInput = z
  .object({
    startMinute: z
      .number()
      .int()
      .min(0)
      .max(MINUTES_IN_A_DAY - 1),
    endMinute: z
      .number()
      .int()
      .min(0)
      .max(MINUTES_IN_A_DAY - 1),
    zone: z.string().min(1).max(64),
    minSeverity: z.enum(severities),
  })
  .refine((value) => value.startMinute !== value.endMinute, {
    message:
      "quiet hours that start and end at the same minute are not a window",
  })
  .refine((value) => isKnownTimeZone(value.zone), {
    message: "not a time zone this runtime knows, for example Europe/Amsterdam",
  });

export const servicePolicyInput = z.object({
  minSeverity: z.enum(severities),
  quietHours: quietHoursInput.nullable().default(null),
  allowedActions: z.array(z.string().min(1).max(60)).max(20),
  flapWindowMinutes: z.number().int().min(1).max(MINUTES_IN_A_DAY),
  // At least one, because zero would mean an alert that can never be called about and never wake
  // up either, which is a service silenced by a number rather than by a decision anyone can see.
  maxCallsPerWindow: z.number().int().min(1).max(20),
  escalateAfterMinutes: z.number().int().min(1).max(60),
});

export type ServicePolicyInput = z.infer<typeof servicePolicyInput>;

/**
 * What a service without a stored policy gets. It calls about everything, keeps no quiet hours, and
 * permits every action the product knows: an install that has configured nothing still telephones
 * somebody, which is the only default an on-call tool is allowed to have.
 */
export function defaultPolicy(
  service: string,
  allActionIds: readonly string[],
  at: string,
): ServicePolicy {
  return {
    service,
    minSeverity: "low",
    quietHours: null,
    allowedActions: [...allActionIds],
    flapWindowMinutes: DEFAULT_FLAP_WINDOW_MINUTES,
    maxCallsPerWindow: DEFAULT_MAX_CALLS_PER_WINDOW,
    escalateAfterMinutes: DEFAULT_ESCALATE_AFTER_MINUTES,
    updatedAt: at,
  };
}

/**
 * When the current quiet-hours window ends, or null when this alert is not held by one.
 *
 * Every uncertainty here resolves towards ringing the telephone. An unknown zone, a severity at or
 * above the window's floor, and a window that does not contain the current minute all return null,
 * because a bug in this function must not be able to hold an incident silently.
 */
export function quietHoursHold(
  quietHours: QuietHours | null,
  severity: Severity,
  now: Date,
): Date | null {
  if (quietHours === null) return null;
  if (severityAtLeast(severity, quietHours.minSeverity)) return null;

  const minute = localMinutes(now, quietHours.zone);
  if (minute === null) return null;
  if (!withinWindow(minute, quietHours.startMinute, quietHours.endMinute))
    return null;

  const remaining =
    (quietHours.endMinute - minute + MINUTES_IN_A_DAY) % MINUTES_IN_A_DAY;
  return new Date(now.getTime() + remaining * 60_000);
}

/**
 * The local wall-clock minute in a named zone, or null when the runtime cannot resolve the zone.
 * hourCycle h23 rather than hour12 false, which renders midnight as 24 in some locales and would
 * put the whole first hour of the day outside every window.
 */
function localMinutes(now: Date, zone: string): number | null {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
  } catch {
    return null;
  }

  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return (hour % 24) * 60 + minute;
}

function withinWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

export type AlertRouting =
  | { kind: "call" }
  | { kind: "defer"; until: Date }
  | { kind: "mute"; until: Date }
  | { kind: "filter" };

export type RoutingInput = {
  policy: ServicePolicy;
  severity: Severity;
  now: Date;
  /** Calls already placed about this exact problem inside the flap window. */
  recentCalls: number;
  /** When the earliest of those was placed, which is the moment the window rolls forward. */
  windowOpenedAt: Date | null;
};

/**
 * What to do about an alert that has just become an incident: telephone somebody, park it until the
 * morning, park it because this problem already rang a phone, or record it and call nobody.
 *
 * Pure on purpose. Everything expensive is read by the caller and passed in, so the one decision
 * that governs whether a person's phone rings at three in the morning can be tested exhaustively
 * without a database.
 */
export function routeAlert(input: RoutingInput): AlertRouting {
  if (!severityAtLeast(input.severity, input.policy.minSeverity))
    return { kind: "filter" };

  if (
    input.recentCalls >= input.policy.maxCallsPerWindow &&
    input.windowOpenedAt !== null
  ) {
    return {
      kind: "mute",
      until: new Date(
        input.windowOpenedAt.getTime() +
          input.policy.flapWindowMinutes * 60_000,
      ),
    };
  }

  const held = quietHoursHold(
    input.policy.quietHours,
    input.severity,
    input.now,
  );
  if (held !== null) return { kind: "defer", until: held };

  return { kind: "call" };
}
