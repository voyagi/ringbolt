import { z } from "zod";

export const incidentStates = [
  "received",
  "calling",
  "deciding",
  "acting",
  "deferred",
  "muted",
  "escalating",
  "snoozed",
  "resolved",
  "held",
  "filtered",
  "failed",
] as const;

export type IncidentState = (typeof incidentStates)[number];

/**
 * An incident counts as open while it can still lead to a call. Two things read this: the duplicate
 * check that decides whether a repeat alert rings a phone, and the unique index in migration 0004
 * that enforces one open incident per fingerprint. Change it here and change it there in the same
 * commit, because a state that is open to one and not the other is a silent second phone call.
 */
export const openIncidentStates = [
  "received",
  "calling",
  "deciding",
  "acting",
  "deferred",
  "muted",
  "escalating",
  "snoozed",
] as const satisfies readonly IncidentState[];

/**
 * States Ringbolt has deliberately parked with a time on them. Each one carries a wakeAt and a
 * wakeReason, the incident's own Durable Object holds an alarm for it, and the reconciliation sweep
 * is the backstop for an alarm that never fires.
 */
export const scheduledStates = [
  "deferred",
  "muted",
  "snoozed",
] as const satisfies readonly IncidentState[];

/**
 * Why an incident is parked, and therefore what happens when its time comes. It is stored on the
 * incident rather than beside the alarm so that the alarm and the sweep read the same answer.
 */
export const wakeReasons = [
  "no_answer",
  "snooze_over",
  "quiet_hours_over",
  "flap_window_over",
] as const;

export type WakeReason = (typeof wakeReasons)[number];

export function isWakeReason(value: unknown): value is WakeReason {
  return (
    typeof value === "string" &&
    (wakeReasons as readonly string[]).includes(value)
  );
}

/** Most severe first. Everything that compares two severities reads that order from here. */
export const severities = ["critical", "high", "low"] as const;
export type Severity = (typeof severities)[number];

/** Whether a severity is at least as serious as a floor. */
export function severityAtLeast(severity: Severity, floor: Severity): boolean {
  return severities.indexOf(severity) <= severities.indexOf(floor);
}

export const alertPayload = z.object({
  service: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  severity: z.enum(severities).default("high"),
  detail: z.string().max(4000).optional(),
  /**
   * Sender-side identity for the same underlying problem, used to collapse repeats into one call.
   * A minimum length because an alert template rendering an empty variable into this field would
   * otherwise give every service in the estate the same identity, and therefore one incident and
   * one phone call between them all, with a 202 and no signal that anything was wrong.
   */
  fingerprint: z.string().min(1).max(200).optional(),
  startedAt: z.iso.datetime().optional(),
  source: z.string().max(120).optional(),
  links: z
    .array(z.object({ label: z.string().max(80), url: z.url() }))
    .max(6)
    .optional(),
});

export type AlertPayload = z.infer<typeof alertPayload>;

export type OfferedAction = {
  id: string;
  label: string;
  /** Spoken to the responder, so it has to be a sentence rather than a description of a function. */
  spokenDescription: string;
  /** The exact words that have to be said back, or null when this one is not destructive. */
  confirmationPhrase: string | null;
};

export type IncidentLink = { label: string; url: string };

export type Incident = {
  id: string;
  state: IncidentState;
  service: string;
  title: string;
  severity: Severity;
  detail: string | null;
  fingerprint: string;
  source: string | null;
  /** When the monitor says the problem began, which is what the responder asks about first. */
  startedAt: string | null;
  links: IncidentLink[];
  /** The action ids read out on the call, so the set that authorizes is the set the responder heard. */
  offeredActions: string[];
  /** When this incident is due to be looked at again. Null unless it is parked. */
  wakeAt: string | null;
  /** What to do when wakeAt arrives. Null unless it is parked. */
  wakeReason: WakeReason | null;
  /** How many calls this incident has cost, which is what keeps each attempt's call distinct. */
  callAttempts: number;
  /** How far down the rotation this incident has got. A snooze calls the same person back. */
  rotationPosition: number;
  /** Who is being called right now, for the audit trail and for the call back after a snooze. */
  contactId: string | null;
  /** When the current call was placed, which is the clock the give-up deadline runs on. */
  callStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
  callId: string | null;
  outcome: string | null;
};

const allowedTransitions: Readonly<
  Record<IncidentState, readonly IncidentState[]>
> = {
  received: ["calling", "deferred", "muted", "filtered", "failed"],
  calling: ["deciding", "escalating", "failed"],
  deciding: ["acting", "held", "escalating", "snoozed", "failed"],
  acting: ["resolved", "failed"],
  deferred: ["calling", "failed"],
  // A mute ends by admitting nobody was called about this one, never by calling late: the window
  // exists precisely because the same problem already rang a phone.
  muted: ["filtered", "failed"],
  escalating: ["calling", "failed"],
  snoozed: ["calling", "failed"],
  resolved: [],
  held: [],
  filtered: [],
  failed: [],
};

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return allowedTransitions[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: IncidentState,
    readonly to: IncidentState,
  ) {
    super(`cannot move an incident from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function transition(
  from: IncidentState,
  to: IncidentState,
): IncidentState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

export function isTerminal(state: IncidentState): boolean {
  return allowedTransitions[state].length === 0;
}

/**
 * A sender that supplies no fingerprint still needs one, or every repeat of the same broken thing
 * becomes another phone call at 3am. Service plus title is the coarsest grouping that is never
 * wrong in the dangerous direction: it can merge two genuinely different problems that share a
 * title, which costs a missed call on the second, where the alternative costs a call per repeat.
 *
 * The two parts go in as a JSON array rather than joined by a separator, because a separator can
 * appear inside either half: service "a" with title "b::c" and service "a::b" with title "c" would
 * otherwise be the same incident. This value also addresses the Durable Object that owns the
 * incident, so an ambiguous join would put two different problems in one owner.
 */
export function fingerprintFor(alert: AlertPayload): string {
  const supplied = alert.fingerprint?.trim();
  if (supplied !== undefined && supplied !== "") return supplied;
  return `service+title:${JSON.stringify([alert.service, alert.title])}`;
}

export function describeForSpeech(
  incident: Pick<
    Incident,
    "service" | "title" | "severity" | "detail" | "startedAt"
  >,
  now: Date,
): string {
  const lines = [
    `Service: ${incident.service}.`,
    `Problem: ${incident.title}.`,
    `Severity: ${incident.severity}.`,
  ];
  const running = describeElapsed(incident.startedAt, now);
  if (running !== null) lines.push(`Started ${running}.`);
  if (incident.detail !== null && incident.detail.trim() !== "")
    lines.push(`Detail: ${incident.detail}`);
  return lines.join(" ");
}

/**
 * A timestamp read out loud is useless to somebody who has just woken up, so it goes over the
 * telephone as a duration. A clock skew that puts the start in the future is reported as just now
 * rather than as a negative age.
 */
function describeElapsed(startedAt: string | null, now: Date): string | null {
  if (startedAt === null) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;

  const minutes = Math.round((now.getTime() - started) / 60_000);
  if (minutes <= 0) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 90) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
