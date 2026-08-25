import type { CallRecord, Repo } from "../db/repo.js";
import type { Incident } from "../domain/incident.js";
import type {
  IncidentState,
  Severity,
  TranscriptTurnView,
  WakeReason,
} from "../domain/view.js";
import { ensureDemoService } from "./service.js";

/**
 * An estate with a past, so nobody meets Ringbolt as an empty screen.
 *
 * A product like this one is unreadable with nothing in it: the board is a board of nothing, the
 * history table has no rows, and the one screen that carries the whole argument, an incident with
 * its transcript and the sentence that authorized the change, cannot be reached at all. So a demo
 * deployment is given six incidents that between them show every outcome the product has: a call
 * that ended in a rollback, a call the responder held, an alert the policy refused to ring anybody
 * about, a call nobody was heard on, and two still open.
 *
 * Every row here is written through the same repository the product writes, in the shapes the
 * product writes them in. Nothing is drawn from a fixture the screens read directly, because a demo
 * whose data cannot be produced by the product is a demonstration of a picture.
 */

/** The one row that says whether this has been done, so running it twice writes nothing twice. */
const MARKER = "inc_demo_past_rollback";

const NADIA = "con_demo_nadia";
const IVO = "con_demo_ivo";

/**
 * Unassigned country code 999, so no telephone network can route either of them. The demo's
 * contacts are fiction and they stay unreachable even if this seed ever ran against a build wired
 * to a real telephone.
 */
const CONTACTS = [
  { id: NADIA, name: "Nadia Brekelmans", phone: "+99900000001" },
  { id: IVO, name: "Ivo Haring", phone: "+99900000002" },
];

type IncidentSeed = {
  id: string;
  service: string;
  title: string;
  severity: Severity;
  state: IncidentState;
  detail: string | null;
  minutesAgo: number;
  endedMinutesAgo: number;
  outcome: string | null;
  contactId: string | null;
  callAttempts: number;
  rotationPosition: number;
  wakeInMinutes?: number;
  wakeReason?: WakeReason;
};

const INCIDENTS: readonly IncidentSeed[] = [
  {
    id: MARKER,
    service: "dockside",
    title: "Payment errors above 20 percent",
    severity: "critical",
    state: "resolved",
    detail: "Error rate 23.4 percent against a 0.2 percent baseline.",
    minutesAgo: 143,
    endedMinutesAgo: 134,
    outcome: "rollback:succeeded",
    contactId: IVO,
    callAttempts: 2,
    rotationPosition: 1,
  },
  {
    id: "inc_demo_past_held",
    service: "search",
    title: "Latency above 5 seconds at the ninety ninth percentile",
    severity: "high",
    state: "held",
    detail: "p99 is 5.4 seconds against a 900 millisecond baseline.",
    minutesAgo: 47,
    endedMinutesAgo: 44,
    outcome: "not_an_action_decision:hold",
    contactId: NADIA,
    callAttempts: 1,
    rotationPosition: 0,
  },
  {
    id: "inc_demo_past_filtered",
    service: "mailer",
    title: "Queue depth past twelve thousand",
    severity: "low",
    state: "filtered",
    detail: "12,410 messages waiting, draining at about 400 a minute.",
    minutesAgo: 26,
    endedMinutesAgo: 26,
    outcome: "below_severity_threshold",
    contactId: null,
    callAttempts: 0,
    rotationPosition: 0,
  },
  {
    id: "inc_demo_past_unheard",
    service: "imports",
    title: "The nightly import failed twice in a row",
    severity: "high",
    state: "failed",
    detail: "Two consecutive runs exited non-zero at the transform step.",
    minutesAgo: 188,
    endedMinutesAgo: 179,
    outcome: "escalation_exhausted",
    contactId: IVO,
    callAttempts: 2,
    rotationPosition: 1,
  },
  {
    id: "inc_demo_open_snoozed",
    service: "warehouse-sync",
    title: "Replication lag past 90 seconds",
    severity: "high",
    state: "snoozed",
    detail: "Lag 94 seconds and climbing since the batch job started.",
    minutesAgo: 19,
    endedMinutesAgo: 17,
    outcome: "not_an_action_decision:snooze",
    contactId: IVO,
    callAttempts: 1,
    rotationPosition: 1,
    wakeInMinutes: 313,
    wakeReason: "snooze_over",
  },
  {
    id: "inc_demo_open_deferred",
    service: "edge-cache",
    title: "Origin fetch failures above 5 percent",
    severity: "high",
    state: "deferred",
    detail: "5.8 percent of origin fetches failing, mostly on the eu edge.",
    minutesAgo: 8,
    endedMinutesAgo: 8,
    outcome: null,
    contactId: null,
    callAttempts: 0,
    rotationPosition: 0,
    wakeInMinutes: 344,
    wakeReason: "quiet_hours_over",
  },
];

type EventSeed = {
  incidentId: string;
  minutesAgo: number;
  kind: string;
  message: string;
};

const EVENTS: readonly EventSeed[] = [
  {
    incidentId: MARKER,
    minutesAgo: 143,
    kind: "alert.received",
    message: "dockside: Payment errors above 20 percent",
  },
  {
    incidentId: MARKER,
    minutesAgo: 143,
    kind: "call.placed",
    message: "Calling Nadia Brekelmans about dockside.",
  },
  {
    incidentId: MARKER,
    minutesAgo: 140,
    kind: "incident.escalated",
    message: "Nobody has resolved this, so Ivo Haring is being called.",
  },
  {
    incidentId: MARKER,
    minutesAgo: 140,
    kind: "call.placed",
    message: "Calling Ivo Haring about dockside.",
  },
  {
    incidentId: MARKER,
    minutesAgo: 135,
    kind: "call.ended",
    message: "The responder authorized a rollback.",
  },
  {
    incidentId: MARKER,
    minutesAgo: 134,
    kind: "action.succeeded",
    message: "dockside moved from 2026.08.24-d to 2026.08.24-c",
  },
  {
    incidentId: "inc_demo_past_held",
    minutesAgo: 47,
    kind: "alert.received",
    message: "search: Latency above 5 seconds at the ninety ninth percentile",
  },
  {
    incidentId: "inc_demo_past_held",
    minutesAgo: 47,
    kind: "call.placed",
    message: "Calling Nadia Brekelmans about search.",
  },
  {
    incidentId: "inc_demo_past_held",
    minutesAgo: 44,
    kind: "call.ended",
    message: "The responder decided to change nothing.",
  },
  {
    incidentId: "inc_demo_past_held",
    minutesAgo: 44,
    kind: "action.refused",
    message: "responder chose to hold",
  },
  {
    incidentId: "inc_demo_past_filtered",
    minutesAgo: 26,
    kind: "alert.received",
    message: "mailer: Queue depth past twelve thousand",
  },
  {
    incidentId: "inc_demo_past_filtered",
    minutesAgo: 26,
    kind: "incident.filtered",
    message:
      "mailer is set to call about high and above. This is low, so it is on the record and nobody is telephoned.",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 188,
    kind: "alert.received",
    message: "imports: The nightly import failed twice in a row",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 188,
    kind: "call.placed",
    message: "Calling Nadia Brekelmans about imports.",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 185,
    kind: "call.ended",
    message: "The call ended.",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 185,
    kind: "action.refused",
    message:
      "the call completed but not one word from the person who answered was transcribed, so there is no evidence anybody authorized anything",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 185,
    kind: "incident.escalated",
    message: "Nobody has resolved this, so Ivo Haring is being called.",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 179,
    kind: "call.ended",
    message: "Nobody picked up.",
  },
  {
    incidentId: "inc_demo_past_unheard",
    minutesAgo: 179,
    kind: "incident.escalation_exhausted",
    message:
      "Everybody in the rotation has been tried and nobody resolved this, so it is closed rather than left holding the alert. The next repeat of this alert rings again.",
  },
  {
    incidentId: "inc_demo_open_snoozed",
    minutesAgo: 19,
    kind: "alert.received",
    message: "warehouse-sync: Replication lag past 90 seconds",
  },
  {
    incidentId: "inc_demo_open_snoozed",
    minutesAgo: 19,
    kind: "call.placed",
    message: "Calling Ivo Haring about warehouse-sync.",
  },
  {
    incidentId: "inc_demo_open_snoozed",
    minutesAgo: 17,
    kind: "call.ended",
    message: "The responder asked to be called back.",
  },
  {
    incidentId: "inc_demo_open_snoozed",
    minutesAgo: 17,
    kind: "action.refused",
    message: "responder chose to snooze",
  },
  {
    incidentId: "inc_demo_open_deferred",
    minutesAgo: 8,
    kind: "alert.received",
    message: "edge-cache: Origin fetch failures above 5 percent",
  },
  {
    incidentId: "inc_demo_open_deferred",
    minutesAgo: 8,
    kind: "incident.deferred",
    message:
      "Quiet hours are in force for edge-cache and a high alert does not break them, so the call waits.",
  },
];

const ROLLBACK_TALK: readonly TranscriptTurnView[] = [
  {
    offsetSeconds: 0,
    speaker: "bot",
    text: "This is Ringbolt, an automated system rather than a person. Dockside payment errors went from nought point two percent to twenty three point four, right after the 2026.08.24-d release.",
  },
  {
    offsetSeconds: 13,
    speaker: "user",
    text: "Is anything else touching payments?",
  },
  {
    offsetSeconds: 16,
    speaker: "bot",
    text: "No. Search and accounts are both clean, and the only change in the window is that release.",
  },
  {
    offsetSeconds: 22,
    speaker: "user",
    text: "Then put it back on the one before.",
  },
  {
    offsetSeconds: 26,
    speaker: "bot",
    text: "I can roll dockside back to 2026.08.24-c. Say roll it back to confirm.",
  },
  { offsetSeconds: 31, speaker: "user", text: "Roll it back." },
];

const HOLD_TALK: readonly TranscriptTurnView[] = [
  {
    offsetSeconds: 0,
    speaker: "bot",
    text: "This is Ringbolt, an automated system rather than a person. Search latency is at five point four seconds at the ninety ninth percentile.",
  },
  {
    offsetSeconds: 12,
    speaker: "user",
    text: "That is the reindex I started. It finishes in about twenty minutes.",
  },
  {
    offsetSeconds: 18,
    speaker: "bot",
    text: "Understood. I can turn search off or leave it alone.",
  },
  { offsetSeconds: 23, speaker: "user", text: "Leave it. Nothing to do here." },
];

const SNOOZE_TALK: readonly TranscriptTurnView[] = [
  {
    offsetSeconds: 0,
    speaker: "bot",
    text: "This is Ringbolt, an automated system rather than a person. Warehouse sync replication lag is ninety four seconds and climbing.",
  },
  {
    offsetSeconds: 11,
    speaker: "user",
    text: "The batch job is still running. Give me half an hour and call me back.",
  },
];

/**
 * The call this product has actually made, over and over: Ringbolt is heard, the responder is not.
 * It is in the seeded history on purpose. It carries a task completed at high confidence with a
 * schema-valid instruction to change production in it, and Ringbolt refused it anyway, which is the
 * single most important thing a stranger can be shown about this product.
 */
const UNHEARD_TALK: readonly TranscriptTurnView[] = [
  {
    offsetSeconds: 0,
    speaker: "bot",
    text: "This is Ringbolt, an automated system rather than a person. The nightly import for imports has failed twice in a row.",
  },
  { offsetSeconds: 0, speaker: "user", text: "" },
  { offsetSeconds: 0, speaker: "bot", text: "Are you still there?" },
  { offsetSeconds: 0, speaker: "user", text: "" },
];

type CallSeed = {
  callId: string;
  incidentId: string;
  contactId: string | null;
  status: string;
  taskCompleted: boolean | null;
  confidence: number | null;
  summary: string | null;
  structuredResult: unknown;
  transcript: readonly TranscriptTurnView[];
  minutesAgo: number;
};

const ROLLBACK_DECISION = {
  decision: "run_action",
  action_id: "rollback",
  confirmation_phrase: "roll it back",
  action_parameters: { release: "2026.08.24-c" },
  reason: "The release is the only thing that changed.",
};

const CALLS: readonly CallSeed[] = [
  {
    callId: "call_demo_1a",
    incidentId: MARKER,
    contactId: NADIA,
    status: "failed",
    taskCompleted: false,
    confidence: null,
    summary: "Nobody picked up.",
    transcript: [],
    structuredResult: null,
    minutesAgo: 140,
  },
  {
    callId: "call_demo_1b",
    incidentId: MARKER,
    contactId: IVO,
    status: "completed",
    taskCompleted: true,
    confidence: 0.93,
    summary: "The responder authorized a rollback to the previous release.",
    transcript: ROLLBACK_TALK,
    structuredResult: ROLLBACK_DECISION,
    minutesAgo: 135,
  },
  {
    callId: "call_demo_2",
    incidentId: "inc_demo_past_held",
    contactId: NADIA,
    status: "completed",
    taskCompleted: true,
    confidence: 0.88,
    summary: "The responder knew what it was and asked for nothing to be done.",
    transcript: HOLD_TALK,
    structuredResult: { decision: "hold", reason: "A reindex I started." },
    minutesAgo: 44,
  },
  {
    callId: "call_demo_3a",
    incidentId: "inc_demo_past_unheard",
    contactId: NADIA,
    status: "completed",
    taskCompleted: true,
    confidence: 0.91,
    summary: "A decision was reached.",
    transcript: UNHEARD_TALK,
    structuredResult: { decision: "run_action", action_id: "kill_switch" },
    minutesAgo: 185,
  },
  {
    callId: "call_demo_3b",
    incidentId: "inc_demo_past_unheard",
    contactId: IVO,
    status: "failed",
    taskCompleted: false,
    confidence: null,
    summary: "Nobody picked up.",
    transcript: [],
    structuredResult: null,
    minutesAgo: 179,
  },
  {
    callId: "call_demo_4",
    incidentId: "inc_demo_open_snoozed",
    contactId: IVO,
    status: "completed",
    taskCompleted: true,
    confidence: 0.9,
    summary: "The responder asked to be called back in half an hour.",
    transcript: SNOOZE_TALK,
    structuredResult: { decision: "snooze", snooze_minutes: 30 },
    minutesAgo: 17,
  },
];

export async function demoHistoryPresent(repo: Repo): Promise<boolean> {
  return (await repo.getIncident(MARKER)) !== null;
}

export type SeedResult = { seeded: boolean; incidents: number };

/**
 * Writes the example estate, once. Everything it writes carries a fixed id, so a second run finds
 * the marker incident and does nothing rather than doubling the history.
 */
export async function seedDemoHistory(
  repo: Repo,
  now: Date,
): Promise<SeedResult> {
  if (await demoHistoryPresent(repo)) {
    return { seeded: false, incidents: 0 };
  }

  await ensureDemoService(repo, now);
  await seedPeople(repo, now);
  await seedPolicies(repo, now);

  for (const seed of INCIDENTS)
    await repo.createIncident(incidentOf(seed, now));
  for (const seed of EVENTS) {
    await repo.appendEvent({
      id: `evt_${seed.incidentId}_${seed.kind}_${seed.minutesAgo}`,
      incidentId: seed.incidentId,
      at: ago(now, seed.minutesAgo),
      kind: seed.kind,
      message: seed.message,
      data: null,
    });
  }
  for (const seed of CALLS) await repo.recordCall(callOf(seed, now));
  await seedActionRun(repo, now);

  return { seeded: true, incidents: INCIDENTS.length };
}

async function seedPeople(repo: Repo, now: Date): Promise<void> {
  const known = new Set((await repo.listContacts()).map((one) => one.id));
  for (const contact of CONTACTS) {
    if (known.has(contact.id)) continue;
    await repo.createContact({ ...contact, createdAt: ago(now, 400) });
  }
  // Only when there is no rota at all. An operator's own calling order is not something an example
  // history gets to rewrite.
  if ((await repo.rotationFor("*")).length === 0) {
    await repo.setRotation("*", [NADIA, IVO]);
  }
}

/**
 * The two policies the history refers to. Without them the record and the configuration screen
 * disagree: an incident that says the policy refused to ring anybody, on a service whose policy
 * says it calls about everything.
 */
async function seedPolicies(repo: Repo, now: Date): Promise<void> {
  const at = now.toISOString();
  const shared = {
    quietHours: null,
    allowedActions: ["kill_switch", "rollback"],
    flapWindowMinutes: 15,
    maxCallsPerWindow: 1,
    escalateAfterMinutes: 3,
    updatedAt: at,
  };
  if ((await repo.getServicePolicy("mailer")) === null) {
    await repo.upsertServicePolicy({
      ...shared,
      service: "mailer",
      minSeverity: "high",
    });
  }
  if ((await repo.getServicePolicy("edge-cache")) === null) {
    await repo.upsertServicePolicy({
      ...shared,
      service: "edge-cache",
      minSeverity: "low",
      quietHours: {
        startMinute: 23 * 60,
        endMinute: 7 * 60,
        zone: "Europe/Amsterdam",
        minSeverity: "critical",
      },
    });
  }
}

/** The one action in the seeded history that ran, with the system state either side of it. */
async function seedActionRun(repo: Repo, now: Date): Promise<void> {
  await repo.recordActionRun({
    id: "run_demo_rollback",
    incidentId: MARKER,
    actionId: "rollback",
    callId: "call_demo_1b",
    contactId: IVO,
    authorizedBy: "Ivo Haring",
    decision: ROLLBACK_DECISION,
    parameters: { release: "2026.08.24-c" },
    stateBefore: {
      service: "dockside",
      killSwitch: false,
      activeRelease: "2026.08.24-d",
      previousRelease: "2026.08.24-c",
    },
    stateAfter: {
      service: "dockside",
      killSwitch: false,
      activeRelease: "2026.08.24-c",
      previousRelease: "2026.08.24-d",
    },
    outcome: "succeeded",
    detail: "dockside moved from 2026.08.24-d to 2026.08.24-c",
    attempts: 1,
    durationMs: 2870,
    verification: {
      verified: true,
      detail: "dockside reads back as it was set",
    },
    at: ago(now, 134),
  });
}

function incidentOf(seed: IncidentSeed, now: Date): Incident {
  const called = seed.callAttempts > 0;
  return {
    id: seed.id,
    state: seed.state,
    service: seed.service,
    title: seed.title,
    severity: seed.severity,
    detail: seed.detail,
    fingerprint: `demo:seed:${seed.id}`,
    source: "prometheus",
    startedAt: ago(now, seed.minutesAgo + 2),
    links: [],
    offeredActions: called ? ["kill_switch", "rollback"] : [],
    wakeAt:
      seed.wakeInMinutes === undefined ? null : ago(now, -seed.wakeInMinutes),
    wakeReason: seed.wakeReason ?? null,
    callAttempts: seed.callAttempts,
    rotationPosition: seed.rotationPosition,
    contactId: seed.contactId,
    callStartedAt: called ? ago(now, seed.endedMinutesAgo + 3) : null,
    createdAt: ago(now, seed.minutesAgo),
    updatedAt: ago(now, seed.endedMinutesAgo),
    // The call id never leaves the service and nothing reads it back off a seeded row, so the
    // example history carries none rather than inventing one.
    callId: null,
    outcome: seed.outcome,
  };
}

function callOf(seed: CallSeed, now: Date): CallRecord {
  return {
    callId: seed.callId,
    incidentId: seed.incidentId,
    contactId: seed.contactId,
    status: seed.status,
    taskCompleted: seed.taskCompleted,
    confidence: seed.confidence,
    summary: seed.summary,
    structuredResult: seed.structuredResult,
    transcript: seed.transcript,
    recordedAt: ago(now, seed.minutesAgo),
  };
}

/** Negative minutes are in the future, which is what a wake time is. */
function ago(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}
