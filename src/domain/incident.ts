import { z } from "zod";

export const incidentStates = [
  "received",
  "calling",
  "deciding",
  "acting",
  "resolved",
  "held",
  "escalating",
  "failed",
] as const;

export type IncidentState = (typeof incidentStates)[number];

export const severities = ["critical", "high", "low"] as const;
export type Severity = (typeof severities)[number];

export const alertPayload = z.object({
  service: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  severity: z.enum(severities).default("high"),
  detail: z.string().max(4000).optional(),
  /** Sender-side identity for the same underlying problem, used to collapse repeats into one call. */
  fingerprint: z.string().max(200).optional(),
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
  confirmationPhrase?: string;
};

export type Incident = {
  id: string;
  state: IncidentState;
  service: string;
  title: string;
  severity: Severity;
  detail: string | null;
  fingerprint: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  callId: string | null;
  outcome: string | null;
};

const allowedTransitions: Readonly<
  Record<IncidentState, readonly IncidentState[]>
> = {
  received: ["calling", "failed"],
  calling: ["deciding", "escalating", "failed"],
  deciding: ["acting", "held", "escalating", "failed"],
  acting: ["resolved", "failed"],
  escalating: ["calling", "failed"],
  resolved: [],
  held: [],
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
 */
export function fingerprintFor(alert: AlertPayload): string {
  return alert.fingerprint ?? `${alert.service}::${alert.title}`;
}

export function describeForSpeech(
  incident: Pick<Incident, "service" | "title" | "severity" | "detail">,
): string {
  const lines = [
    `Service: ${incident.service}.`,
    `Problem: ${incident.title}.`,
    `Severity: ${incident.severity}.`,
  ];
  if (incident.detail !== null && incident.detail.trim() !== "")
    lines.push(`Detail: ${incident.detail}`);
  return lines.join(" ");
}
