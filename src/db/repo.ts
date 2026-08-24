import type { ActionDefinition } from "../actions/definition.js";
import { actionDefinitionInput } from "../actions/definition.js";
import type {
  Incident,
  IncidentLink,
  IncidentState,
  Severity,
} from "../domain/incident.js";
import { isWakeReason, openIncidentStates } from "../domain/incident.js";
import type { QuietHours, ServicePolicy } from "../domain/policy.js";
import { quietHoursInput } from "../domain/policy.js";
import type { Contact } from "../domain/rotation.js";

const OPEN_STATES = openIncidentStates.map((state) => `'${state}'`).join(", ");

/** Every state Ringbolt parks an incident in with a time on it, as a SQL list. */
const SCHEDULED_STATES = "'deferred', 'muted', 'snoozed'";

/** Every state an incident can sit in while something is supposed to be happening to it. */
const ACTIVE_STATES =
  "'received', 'calling', 'deciding', 'acting', 'escalating'";

/** The rota a service falls back to when it has none of its own. */
export const SHARED_ROTATION = "*";

export type IncidentPatch = Partial<
  Pick<
    Incident,
    | "state"
    | "callId"
    | "outcome"
    | "wakeAt"
    | "wakeReason"
    | "offeredActions"
    | "callAttempts"
    | "rotationPosition"
    | "contactId"
    | "callStartedAt"
  >
>;

function encodePatchValue(
  value: IncidentPatch[keyof IncidentPatch],
): string | number | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

export type IncidentEvent = {
  id: string;
  incidentId: string;
  at: string;
  kind: string;
  message: string;
  data: unknown;
};

export type ServiceState = {
  service: string;
  killSwitch: boolean;
  activeRelease: string;
  previousRelease: string | null;
  updatedAt: string;
};

/**
 * One carried-out action, and everything a person would need to judge it afterwards: which call
 * authorized it, who was on that call, what they decided, what values they gave, what the system
 * looked like either side of it, and whether anybody checked that it took.
 */
export type ActionRun = {
  id: string;
  incidentId: string;
  actionId: string;
  callId: string | null;
  contactId: string | null;
  /** The name of the person who authorized it, kept here so deleting a contact cannot erase it. */
  authorizedBy: string | null;
  decision: unknown;
  parameters: unknown;
  stateBefore: unknown;
  stateAfter: unknown;
  outcome: "succeeded" | "failed" | "unverified";
  detail: string | null;
  attempts: number;
  durationMs: number | null;
  verification: unknown;
  at: string;
};

/**
 * What was said on the call. It is kept here rather than left in CALL-E's records, which expire and
 * cannot be read without their API, and it is personal data: the endpoint that serves it is behind
 * the admin token, and phase 7 gives it a retention window.
 */
export type CallRecord = {
  callId: string;
  incidentId: string;
  contactId: string | null;
  status: string;
  taskCompleted: boolean | null;
  confidence: number | null;
  summary: string | null;
  structuredResult: unknown;
  transcript: unknown;
  recordedAt: string;
};

type IncidentRow = {
  id: string;
  state: string;
  service: string;
  title: string;
  severity: string;
  detail: string | null;
  fingerprint: string;
  source: string | null;
  started_at: string | null;
  links: string | null;
  offered_actions: string | null;
  wake_at: string | null;
  wake_reason: string | null;
  call_attempts: number;
  rotation_position: number;
  contact_id: string | null;
  call_started_at: string | null;
  call_id: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
};

type ContactRow = {
  id: string;
  name: string;
  phone: string;
  created_at: string;
};

type ActionRunRow = {
  id: string;
  incident_id: string;
  action_id: string;
  call_id: string | null;
  contact_id: string | null;
  authorized_by: string | null;
  decision: string | null;
  parameters: string | null;
  state_before: string | null;
  state_after: string | null;
  outcome: string;
  detail: string | null;
  attempts: number;
  duration_ms: number | null;
  verification: string | null;
  at: string;
};

type CallRecordRow = {
  call_id: string;
  incident_id: string;
  contact_id: string | null;
  status: string;
  task_completed: number | null;
  confidence: number | null;
  summary: string | null;
  structured_result: string | null;
  transcript: string;
  recorded_at: string;
};

type ActionDefinitionRow = {
  id: string;
  label: string;
  spoken_description: string;
  confirmation_phrase: string | null;
  min_confidence: number | null;
  parameters: string;
  target: string;
  verify: string | null;
  created_at: string;
  updated_at: string;
};

type ServicePolicyRow = {
  service: string;
  min_severity: string;
  quiet_hours: string | null;
  allowed_actions: string;
  flap_window_minutes: number;
  max_calls_per_window: number;
  escalate_after_minutes: number;
  updated_at: string;
};

/** How often the same problem has already rung a phone, and when that window opened. */
export type CallWindow = { calls: number; openedAt: string | null };

/**
 * The unique index on open fingerprints rejecting a second open incident. That is a race being
 * caught rather than a fault, so the caller turns it into the duplicate answer the winning writer
 * would have given, instead of a five hundred and a retry.
 */
export function isDuplicateOpenIncident(error: unknown): boolean {
  const messages: string[] = [];
  for (let cause: unknown = error, depth = 0; depth < 4; depth += 1) {
    if (!(cause instanceof Error)) break;
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages.some(
    (message) =>
      /unique constraint failed/i.test(message) &&
      /incidents\.fingerprint/i.test(message),
  );
}

export class Repo {
  constructor(private readonly db: D1Database) {}

  async createIncident(incident: Incident): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO incidents (id, state, service, title, severity, detail, fingerprint, source, started_at, links, offered_actions, wake_at, wake_reason, call_attempts, rotation_position, contact_id, call_started_at, call_id, outcome, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
      )
      .bind(
        incident.id,
        incident.state,
        incident.service,
        incident.title,
        incident.severity,
        incident.detail,
        incident.fingerprint,
        incident.source,
        incident.startedAt,
        incident.links.length === 0 ? null : JSON.stringify(incident.links),
        incident.offeredActions.length === 0
          ? null
          : JSON.stringify(incident.offeredActions),
        incident.wakeAt,
        incident.wakeReason,
        incident.callAttempts,
        incident.rotationPosition,
        incident.contactId,
        incident.callStartedAt,
        incident.callId,
        incident.outcome,
        incident.createdAt,
        incident.updatedAt,
      )
      .run();
  }

  async getIncident(id: string): Promise<Incident | null> {
    const row = await this.db
      .prepare(`SELECT * FROM incidents WHERE id = ?1`)
      .bind(id)
      .first<IncidentRow>();
    return row === null ? null : toIncident(row);
  }

  async listIncidents(limit = 50): Promise<Incident[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM incidents ORDER BY created_at DESC LIMIT ?1`)
      .bind(limit)
      .all<IncidentRow>();
    return results.map(toIncident);
  }

  /**
   * An incident counts as open while it can still lead to a call, which is what makes a repeat
   * alert a duplicate rather than a new problem.
   */
  async findOpenByFingerprint(fingerprint: string): Promise<Incident | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM incidents
         WHERE fingerprint = ?1 AND state IN (${OPEN_STATES})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(fingerprint)
      .first<IncidentRow>();
    return row === null ? null : toIncident(row);
  }

  /**
   * Incidents the sweep should look at, oldest first. Every open state is covered, not just the one
   * waiting on a call: an incident that stops anywhere counts as open, and an open incident answers
   * every later repeat of its alert as a duplicate, so any uncovered state is a way to silence a
   * service for good.
   *
   * Two clocks, because there are two ways to stop. An active state is late when nothing has
   * touched it for a while. A parked state is late only once its own deadline has passed by more
   * than the grace period, which is what keeps the sweep out of the way of the alarm that is
   * supposed to handle it. A parked state with no deadline at all has nothing to be late against,
   * so the third clause catches it on the active clock rather than leaving it there for ever.
   */
  async findStalledIncidents(
    thresholds: { active: string; wake: string },
    limit: number,
  ): Promise<Incident[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM incidents
         WHERE (state IN (${ACTIVE_STATES}) AND updated_at < ?1)
            OR (state IN (${SCHEDULED_STATES}) AND wake_at IS NOT NULL AND wake_at < ?2)
            OR (state IN (${SCHEDULED_STATES}) AND wake_at IS NULL AND updated_at < ?1)
         ORDER BY updated_at ASC LIMIT ?3`,
      )
      .bind(thresholds.active, thresholds.wake, limit)
      .all<IncidentRow>();
    return results.map(toIncident);
  }

  /**
   * How often this exact problem has already rung a phone inside the flap window, and when the
   * earliest of those calls was, which is the moment the window rolls forward. The incident being
   * routed is excluded by id: it is asking whether it may call, so it must not count itself.
   */
  async callsInWindow(
    fingerprint: string,
    since: string,
    excludingIncidentId: string,
  ): Promise<CallWindow> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS calls, MIN(created_at) AS opened_at FROM incidents
         WHERE fingerprint = ?1 AND call_id IS NOT NULL AND created_at >= ?2 AND id <> ?3`,
      )
      .bind(fingerprint, since, excludingIncidentId)
      .first<{ calls: number; opened_at: string | null }>();
    return { calls: row?.calls ?? 0, openedAt: row?.opened_at ?? null };
  }

  /**
   * The SET clause is built from the keys the patch actually carries, so clearing a column and
   * omitting it are different requests. COALESCE cannot tell them apart: it reads an intentional
   * null as "leave this alone", which makes a clear report success and write nothing.
   */
  async updateIncident(
    id: string,
    patch: IncidentPatch,
    at: string,
  ): Promise<void> {
    const columns: Record<keyof IncidentPatch, string> = {
      state: "state",
      callId: "call_id",
      outcome: "outcome",
      wakeAt: "wake_at",
      wakeReason: "wake_reason",
      offeredActions: "offered_actions",
      callAttempts: "call_attempts",
      rotationPosition: "rotation_position",
      contactId: "contact_id",
      callStartedAt: "call_started_at",
    };

    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(columns) as (keyof IncidentPatch)[]) {
      // Present-but-undefined is skipped rather than written as null. Omitting a field and clearing
      // it stay different requests, but the difference is carried by an explicit null: two of these
      // columns are NOT NULL, and a spread that happens to carry an undefined would otherwise turn
      // a routine update into a constraint failure halfway through an incident.
      if (!(key in patch) || patch[key] === undefined) continue;
      assignments.push(`${columns[key]} = ?`);
      values.push(encodePatchValue(patch[key]));
    }
    assignments.push(`updated_at = ?`);
    values.push(at);

    await this.db
      .prepare(`UPDATE incidents SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async appendEvent(event: IncidentEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO incident_events (id, incident_id, at, kind, message, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        event.id,
        event.incidentId,
        event.at,
        event.kind,
        event.message,
        JSON.stringify(event.data ?? null),
      )
      .run();
  }

  async listEvents(incidentId: string): Promise<IncidentEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM incident_events WHERE incident_id = ?1 ORDER BY at ASC`,
      )
      .bind(incidentId)
      .all<{
        id: string;
        incident_id: string;
        at: string;
        kind: string;
        message: string;
        data: string | null;
      }>();
    return results.map((row) => ({
      id: row.id,
      incidentId: row.incident_id,
      at: row.at,
      kind: row.kind,
      message: row.message,
      data: row.data === null ? null : (JSON.parse(row.data) as unknown),
    }));
  }

  async getServiceState(service: string): Promise<ServiceState | null> {
    const row = await this.db
      .prepare(`SELECT * FROM service_state WHERE service = ?1`)
      .bind(service)
      .first<{
        service: string;
        kill_switch: number;
        active_release: string;
        previous_release: string | null;
        updated_at: string;
      }>();
    if (row === null) return null;
    return {
      service: row.service,
      killSwitch: row.kill_switch === 1,
      activeRelease: row.active_release,
      previousRelease: row.previous_release,
      updatedAt: row.updated_at,
    };
  }

  async upsertServiceState(state: ServiceState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO service_state (service, kill_switch, active_release, previous_release, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (service) DO UPDATE SET
           kill_switch = excluded.kill_switch,
           active_release = excluded.active_release,
           previous_release = excluded.previous_release,
           updated_at = excluded.updated_at`,
      )
      .bind(
        state.service,
        state.killSwitch ? 1 : 0,
        state.activeRelease,
        state.previousRelease,
        state.updatedAt,
      )
      .run();
  }

  async recordActionRun(run: ActionRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO action_runs (id, incident_id, action_id, call_id, contact_id, authorized_by, decision, parameters, state_before, state_after, outcome, detail, attempts, duration_ms, verification, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .bind(
        run.id,
        run.incidentId,
        run.actionId,
        run.callId,
        run.contactId,
        run.authorizedBy,
        JSON.stringify(run.decision ?? null),
        JSON.stringify(run.parameters ?? null),
        JSON.stringify(run.stateBefore ?? null),
        JSON.stringify(run.stateAfter ?? null),
        run.outcome,
        run.detail,
        run.attempts,
        run.durationMs,
        JSON.stringify(run.verification ?? null),
        run.at,
      )
      .run();
  }

  async listActionRuns(incidentId: string): Promise<ActionRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM action_runs WHERE incident_id = ?1 ORDER BY at ASC`,
      )
      .bind(incidentId)
      .all<ActionRunRow>();
    return results.map(toActionRun);
  }

  async recordCall(record: CallRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO call_records (call_id, incident_id, contact_id, status, task_completed, confidence, summary, structured_result, transcript, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (call_id) DO UPDATE SET
           status = excluded.status,
           task_completed = excluded.task_completed,
           confidence = excluded.confidence,
           summary = excluded.summary,
           structured_result = excluded.structured_result,
           transcript = excluded.transcript,
           recorded_at = excluded.recorded_at`,
      )
      .bind(
        record.callId,
        record.incidentId,
        record.contactId,
        record.status,
        record.taskCompleted === null ? null : Number(record.taskCompleted),
        record.confidence,
        record.summary,
        JSON.stringify(record.structuredResult ?? null),
        JSON.stringify(record.transcript ?? []),
        record.recordedAt,
      )
      .run();
  }

  async listCallRecords(incidentId: string): Promise<CallRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM call_records WHERE incident_id = ?1 ORDER BY recorded_at ASC`,
      )
      .bind(incidentId)
      .all<CallRecordRow>();
    return results.map(toCallRecord);
  }

  /**
   * Every action this install can carry out. A row that no longer parses is dropped rather than
   * offered: a definition Ringbolt cannot read is one it cannot reason about, and the safe way to
   * fail on that is to have nothing to offer rather than to offer something half understood.
   */
  async listActionDefinitions(): Promise<ActionDefinition[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM action_definitions ORDER BY id ASC`)
      .all<ActionDefinitionRow>();
    return results
      .map(toActionDefinition)
      .filter(
        (definition): definition is ActionDefinition => definition !== null,
      );
  }

  async getActionDefinition(id: string): Promise<ActionDefinition | null> {
    const row = await this.db
      .prepare(`SELECT * FROM action_definitions WHERE id = ?1`)
      .bind(id)
      .first<ActionDefinitionRow>();
    return row === null ? null : toActionDefinition(row);
  }

  async upsertActionDefinition(definition: ActionDefinition): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO action_definitions (id, label, spoken_description, confirmation_phrase, min_confidence, parameters, target, verify, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET
           label = excluded.label,
           spoken_description = excluded.spoken_description,
           confirmation_phrase = excluded.confirmation_phrase,
           min_confidence = excluded.min_confidence,
           parameters = excluded.parameters,
           target = excluded.target,
           verify = excluded.verify,
           updated_at = excluded.updated_at`,
      )
      .bind(
        definition.id,
        definition.label,
        definition.spokenDescription,
        definition.confirmationPhrase,
        definition.minConfidence,
        JSON.stringify(definition.parameters),
        JSON.stringify(definition.target),
        definition.verify === null ? null : JSON.stringify(definition.verify),
        definition.createdAt,
        definition.updatedAt,
      )
      .run();
  }

  async deleteActionDefinition(id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM action_definitions WHERE id = ?1`)
      .bind(id)
      .run();
  }

  /** Which services still permit this action, so removing one cannot silently change a policy. */
  async policiesPermitting(actionId: string): Promise<string[]> {
    const policies = await this.listServicePolicies();
    return policies
      .filter((policy) => policy.allowedActions.includes(actionId))
      .map((policy) => policy.service);
  }

  /**
   * Takes ownership of a webhook event id, returning false when somebody else already has it.
   *
   * The claim is deliberately not the whole story: it marks the id in flight, and completeEvent
   * closes it once the responder's decision has actually been carried out. A delivery that fails
   * releases the claim on its way out, and one whose isolate died leaves an in-flight row that this
   * statement takes over once it is older than staleBefore. Burning the id up front is what turned
   * a single provider timeout into a decision that could never be delivered again, because the
   * provider's retry is the only recovery this design has.
   *
   * The whole thing is one statement so two concurrent deliveries of the same id cannot both win.
   */
  async claimEvent(
    eventId: string,
    claimId: string,
    at: string,
    staleBefore: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO processed_events (event_id, received_at, status, completed_at, claim_id)
         VALUES (?1, ?2, 'in_flight', NULL, ?4)
         ON CONFLICT (event_id) DO UPDATE SET received_at = ?2, claim_id = ?4
         WHERE processed_events.status = 'in_flight' AND processed_events.received_at < ?3`,
      )
      .bind(eventId, at, staleBefore, claimId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async completeEvent(
    eventId: string,
    claimId: string,
    at: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processed_events SET status = 'done', completed_at = ?3
         WHERE event_id = ?1 AND claim_id = ?2`,
      )
      .bind(eventId, claimId, at)
      .run();
  }

  /**
   * Only the delivery that still holds the claim may give it back. A delivery slow enough to lose
   * its claim to a takeover would otherwise delete the row belonging to whoever took it, and the
   * event id would quietly stop being a deduplication key at all.
   */
  async releaseEvent(eventId: string, claimId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM processed_events
         WHERE event_id = ?1 AND claim_id = ?2 AND status = 'in_flight'`,
      )
      .bind(eventId, claimId)
      .run();
  }

  /** Nothing else removes rows from this table, and an unauthenticated endpoint writes to it. */
  async pruneProcessedEvents(receivedBefore: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM processed_events WHERE received_at < ?1`)
      .bind(receivedBefore)
      .run();
    return result.meta.changes ?? 0;
  }

  async recordRealCall(
    callId: string,
    incidentId: string,
    at: string,
    placer: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO call_ledger (call_id, incident_id, placed_at, placer) VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(callId, incidentId, at, placer)
      .run();
  }

  async countRealCalls(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM call_ledger WHERE placer = 'live'`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** How many real calls were placed since a moment, which is what bounds a burst of them. */
  async countRealCallsSince(placedAfter: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM call_ledger WHERE placer = 'live' AND placed_at >= ?1`,
      )
      .bind(placedAfter)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async getServicePolicy(service: string): Promise<ServicePolicy | null> {
    const row = await this.db
      .prepare(`SELECT * FROM service_policy WHERE service = ?1`)
      .bind(service)
      .first<ServicePolicyRow>();
    return row === null ? null : toServicePolicy(row);
  }

  async listServicePolicies(): Promise<ServicePolicy[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM service_policy ORDER BY service ASC`)
      .all<ServicePolicyRow>();
    return results.map(toServicePolicy);
  }

  async upsertServicePolicy(policy: ServicePolicy): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO service_policy (service, min_severity, quiet_hours, allowed_actions, flap_window_minutes, max_calls_per_window, escalate_after_minutes, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (service) DO UPDATE SET
           min_severity = excluded.min_severity,
           quiet_hours = excluded.quiet_hours,
           allowed_actions = excluded.allowed_actions,
           flap_window_minutes = excluded.flap_window_minutes,
           max_calls_per_window = excluded.max_calls_per_window,
           escalate_after_minutes = excluded.escalate_after_minutes,
           updated_at = excluded.updated_at`,
      )
      .bind(
        policy.service,
        policy.minSeverity,
        policy.quietHours === null ? null : JSON.stringify(policy.quietHours),
        JSON.stringify(policy.allowedActions),
        policy.flapWindowMinutes,
        policy.maxCallsPerWindow,
        policy.escalateAfterMinutes,
        policy.updatedAt,
      )
      .run();
  }

  async listContacts(): Promise<Contact[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM contacts ORDER BY created_at ASC`)
      .all<ContactRow>();
    return results.map(toContact);
  }

  async getContact(id: string): Promise<Contact | null> {
    const row = await this.db
      .prepare(`SELECT * FROM contacts WHERE id = ?1`)
      .bind(id)
      .first<ContactRow>();
    return row === null ? null : toContact(row);
  }

  async createContact(contact: Contact): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO contacts (id, name, phone, created_at) VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(contact.id, contact.name, contact.phone, contact.createdAt)
      .run();
  }

  async deleteContact(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM contacts WHERE id = ?1`).bind(id).run();
  }

  /** Which services still name this contact, so deleting one cannot quietly shorten a rota. */
  async rotationsNaming(contactId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT service FROM rotation WHERE contact_id = ?1 ORDER BY service ASC`,
      )
      .bind(contactId)
      .all<{ service: string }>();
    return results.map((row) => row.service);
  }

  /**
   * The people a service calls, in order. A service with a rota of its own uses it; everything else
   * falls back to the shared one, so adding a service does not mean rebuilding the rota.
   */
  async rotationFor(service: string): Promise<Contact[]> {
    const own = await this.rotationRows(service);
    if (own.length > 0) return own;
    return service === SHARED_ROTATION
      ? []
      : this.rotationRows(SHARED_ROTATION);
  }

  /** Whether this service has a rota of its own, as opposed to inheriting the shared one. */
  async hasOwnRotation(service: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS present FROM rotation WHERE service = ?1 LIMIT 1`)
      .bind(service)
      .first<{ present: number }>();
    return row !== null;
  }

  async setRotation(service: string, contactIds: string[]): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM rotation WHERE service = ?1`).bind(service),
      ...contactIds.map((contactId, position) =>
        this.db
          .prepare(
            `INSERT INTO rotation (service, position, contact_id) VALUES (?1, ?2, ?3)`,
          )
          .bind(service, position, contactId),
      ),
    ]);
  }

  private async rotationRows(service: string): Promise<Contact[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.created_at FROM rotation r
         JOIN contacts c ON c.id = r.contact_id
         WHERE r.service = ?1 ORDER BY r.position ASC`,
      )
      .bind(service)
      .all<ContactRow>();
    return results.map(toContact);
  }
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    state: row.state as IncidentState,
    service: row.service,
    title: row.title,
    severity: row.severity as Severity,
    detail: row.detail,
    fingerprint: row.fingerprint,
    source: row.source,
    startedAt: row.started_at,
    links: row.links === null ? [] : (JSON.parse(row.links) as IncidentLink[]),
    offeredActions:
      row.offered_actions === null
        ? []
        : (JSON.parse(row.offered_actions) as string[]),
    wakeAt: row.wake_at,
    wakeReason: isWakeReason(row.wake_reason) ? row.wake_reason : null,
    callAttempts: row.call_attempts,
    rotationPosition: row.rotation_position,
    contactId: row.contact_id,
    callStartedAt: row.call_started_at,
    callId: row.call_id,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson(stored: string | null): unknown {
  if (stored === null) return null;
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return null;
  }
}

function toActionRun(row: ActionRunRow): ActionRun {
  return {
    id: row.id,
    incidentId: row.incident_id,
    actionId: row.action_id,
    callId: row.call_id,
    contactId: row.contact_id,
    authorizedBy: row.authorized_by,
    decision: parseJson(row.decision),
    parameters: parseJson(row.parameters),
    stateBefore: parseJson(row.state_before),
    stateAfter: parseJson(row.state_after),
    outcome: row.outcome as ActionRun["outcome"],
    detail: row.detail,
    attempts: row.attempts,
    durationMs: row.duration_ms,
    verification: parseJson(row.verification),
    at: row.at,
  };
}

function toCallRecord(row: CallRecordRow): CallRecord {
  return {
    callId: row.call_id,
    incidentId: row.incident_id,
    contactId: row.contact_id,
    status: row.status,
    taskCompleted:
      row.task_completed === null ? null : row.task_completed === 1,
    confidence: row.confidence,
    summary: row.summary,
    structuredResult: parseJson(row.structured_result),
    transcript: parseJson(row.transcript) ?? [],
    recordedAt: row.recorded_at,
  };
}

function toActionDefinition(row: ActionDefinitionRow): ActionDefinition | null {
  const parsed = actionDefinitionInput.safeParse({
    label: row.label,
    spokenDescription: row.spoken_description,
    confirmationPhrase: row.confirmation_phrase,
    minConfidence: row.min_confidence,
    parameters: parseJson(row.parameters) ?? [],
    target: parseJson(row.target),
    verify: parseJson(row.verify),
  });
  if (!parsed.success) return null;

  return {
    ...parsed.data,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    createdAt: row.created_at,
  };
}

/**
 * A stored policy is written only through the validated configuration endpoint, but the value that
 * decides whether a phone rings at three in the morning is checked again on the way out anyway. A
 * quiet-hours block that no longer parses is dropped rather than obeyed, which fails towards
 * ringing: the alternative is a row nobody can read silencing a service nobody is watching.
 */
function toServicePolicy(row: ServicePolicyRow): ServicePolicy {
  return {
    service: row.service,
    minSeverity: row.min_severity as Severity,
    quietHours: parseQuietHours(row.quiet_hours),
    allowedActions: JSON.parse(row.allowed_actions) as string[],
    flapWindowMinutes: row.flap_window_minutes,
    maxCallsPerWindow: row.max_calls_per_window,
    escalateAfterMinutes: row.escalate_after_minutes,
    updatedAt: row.updated_at,
  };
}

function parseQuietHours(stored: string | null): QuietHours | null {
  if (stored === null) return null;
  const parsed = quietHoursInput.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : null;
}
