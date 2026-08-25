import { CALL_PRICE_USD, usd } from "../calle/port.js";
import type { ActionRun, CallRecord, IncidentEvent, Repo } from "../db/repo.js";
import { SHARED_ROTATION } from "../db/repo.js";
import type { Incident } from "../domain/incident.js";
import type {
  ActionRunView,
  ArrivalBucket,
  BoardView,
  CallView,
  DeckFocus,
  EventView,
  IncidentView,
  TranscriptTurnView,
} from "../domain/view.js";

/**
 * Everything the deck shows, read in one request.
 *
 * It is one endpoint rather than six because the deck is one instrument: a board assembled from six
 * separate polls shows six different moments, and the number in the footer would disagree with the
 * list above it often enough for somebody to notice and stop trusting either.
 */

/** How far back the arrival trace looks, and how wide each of its buckets is. */
export const ARRIVAL_WINDOW_MINUTES = 50;
export const ARRIVAL_BUCKET_MINUTES = 5;

const BUCKETS = ARRIVAL_WINDOW_MINUTES / ARRIVAL_BUCKET_MINUTES;

export async function readBoard(
  repo: Repo,
  now: Date,
  creditUsd: number,
): Promise<BoardView> {
  const open = await repo.listOpenIncidents();
  const contacts = await repo.listContacts();
  const names = new Map(contacts.map((one) => [one.id, one.name]));

  // The incident on the phone is the one the whole left and centre of the deck is about. When more
  // than one is ringing, the most severe wins, and among equals the one that has been waiting
  // longest: a board that picked the newest would swap focus every time an alert arrived.
  const ringing = open
    .filter((incident) => incident.state === "calling")
    .sort(byUrgency);
  const focused = ringing[0] ?? open.slice().sort(byUrgency)[0] ?? null;

  const midnight = startOfDayUtc(now);
  const placed = await repo.countRealCalls();
  const spentUsd = usd(placed * CALL_PRICE_USD);
  const remainingUsd = usd(Math.max(0, creditUsd - spentUsd));
  const rotaContacts = await repo.rotationFor(SHARED_ROTATION);

  return {
    now: now.toISOString(),
    focus: focused === null ? null : await readFocus(repo, focused, names, now),
    standing: open
      .filter((incident) => incident.id !== focused?.id)
      .sort(byUrgency)
      .map((incident) => toView(incident, names)),
    counts: {
      open: open.length,
      onTheLine: ringing.length,
      actedToday: await repo.countActionRunsSince(midnight),
      refusedToday: await repo.countRefusalsSince(midnight),
    },
    rota: {
      service: SHARED_ROTATION,
      contacts: rotaContacts.map((one) => ({ id: one.id, name: one.name })),
      // With nobody in the rota the number in the deployment configuration is who gets called.
      // Saying so is what stops an empty list reading as "this rings nobody".
      usesConfiguredNumber: rotaContacts.length === 0,
    },
    budget: {
      realCallsPlaced: placed,
      callPriceUsd: CALL_PRICE_USD,
      spentUsd,
      creditUsd,
      remainingUsd,
      callsRemaining: Math.floor(remainingUsd / CALL_PRICE_USD),
    },
  };
}

async function readFocus(
  repo: Repo,
  incident: Incident,
  names: Map<string, string>,
  now: Date,
): Promise<DeckFocus> {
  const since = new Date(
    now.getTime() - ARRIVAL_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const calls = await repo.listCallRecords(incident.id);
  const runs = await repo.listActionRuns(incident.id);
  const events = await repo.listEvents(incident.id);

  return {
    incident: toView(incident, names),
    // The last call is the one on screen. An escalated incident has one record per person tried,
    // and the deck is about what is happening now rather than about the whole history, which is
    // what the incident page is for.
    call: toCallView(calls[calls.length - 1]),
    events: events.map(toEventView),
    actions: runs.map(toActionRunView),
    arrivals: bucketArrivals(
      await repo.alertArrivals(incident.service, since),
      now,
    ),
    repeats: await repo.countRepeats(incident.id),
  };
}

/**
 * Alert arrivals laid into fixed windows ending now, oldest first. Every bucket is present even
 * when it is empty, because a trace drawn only from the buckets that had something in them
 * compresses a quiet hour and a busy minute into the same width.
 */
export function bucketArrivals(
  arrivals: readonly string[],
  now: Date,
): ArrivalBucket[] {
  const width = ARRIVAL_BUCKET_MINUTES * 60_000;
  // Anchored to the bucket boundary rather than to now, so the trace does not shuffle sideways
  // every time the board polls.
  const end = Math.floor(now.getTime() / width) * width + width;
  const buckets: ArrivalBucket[] = [];
  for (let index = BUCKETS - 1; index >= 0; index -= 1) {
    buckets.push({
      at: new Date(end - (index + 1) * width).toISOString(),
      alerts: 0,
    });
  }

  for (const at of arrivals) {
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed)) continue;
    const index = BUCKETS - 1 - Math.floor((end - parsed) / width);
    const bucket = buckets[index];
    if (bucket !== undefined) bucket.alerts += 1;
  }
  return buckets;
}

export function toView(
  incident: Incident,
  names: Map<string, string>,
): IncidentView {
  return {
    id: incident.id,
    state: incident.state,
    service: incident.service,
    title: incident.title,
    severity: incident.severity,
    detail: incident.detail,
    source: incident.source,
    startedAt: incident.startedAt,
    links: incident.links,
    offeredActions: incident.offeredActions,
    wakeAt: incident.wakeAt,
    wakeReason: incident.wakeReason,
    callAttempts: incident.callAttempts,
    rotationPosition: incident.rotationPosition,
    callStartedAt: incident.callStartedAt,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    outcome: incident.outcome,
    contactName:
      incident.contactId === null
        ? null
        : (names.get(incident.contactId) ?? null),
  };
}

export function toCallView(record: CallRecord | undefined): CallView | null {
  if (record === undefined) return null;
  return {
    status: record.status,
    taskCompleted: record.taskCompleted,
    confidence: record.confidence,
    summary: record.summary,
    transcript: readTranscript(record.transcript),
    recordedAt: record.recordedAt,
    redactedAt: record.redactedAt,
  };
}

/**
 * The transcript as stored, checked on the way out rather than trusted.
 *
 * It arrived from a third party, went through JSON, and is drawn as somebody's words on a screen.
 * A turn whose text is not a string is dropped instead of rendered as `[object Object]`, and an
 * unrecognised speaker becomes `unknown`, which is the same value the authorization gate refuses to
 * treat as the responder.
 */
export function readTranscript(stored: unknown): TranscriptTurnView[] {
  if (!Array.isArray(stored)) return [];
  const turns: TranscriptTurnView[] = [];
  for (const entry of stored) {
    if (entry === null || typeof entry !== "object") continue;
    const turn = entry as Record<string, unknown>;
    if (typeof turn["text"] !== "string") continue;
    const speaker = turn["speaker"];
    const offset = turn["offsetSeconds"];
    turns.push({
      text: turn["text"],
      speaker:
        speaker === "bot" || speaker === "user" || speaker === "unknown"
          ? speaker
          : "unknown",
      offsetSeconds: typeof offset === "number" ? offset : null,
    });
  }
  return turns;
}

export function toActionRunView(run: ActionRun): ActionRunView {
  return {
    id: run.id,
    actionId: run.actionId,
    authorizedBy: run.authorizedBy,
    outcome: run.outcome,
    detail: run.detail,
    attempts: run.attempts,
    durationMs: run.durationMs,
    verification: run.verification,
    stateBefore: run.stateBefore,
    stateAfter: run.stateAfter,
    decision: run.decision,
    parameters: run.parameters,
    at: run.at,
  };
}

export function toEventView(event: IncidentEvent): EventView {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    message: event.message,
  };
}

/** Most severe first, and among equals the one that has been open longest. */
function byUrgency(left: Incident, right: Incident): number {
  const order = { critical: 0, high: 1, low: 2 };
  const bySeverity = order[left.severity] - order[right.severity];
  if (bySeverity !== 0) return bySeverity;
  return left.createdAt.localeCompare(right.createdAt);
}

function startOfDayUtc(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
