import type {
  Incident,
  IncidentLink,
  IncidentState,
  Severity,
} from "../domain/incident.js";
import { openIncidentStates } from "../domain/incident.js";

const OPEN_STATES = openIncidentStates.map((state) => `'${state}'`).join(", ");

export type IncidentPatch = Partial<
  Pick<Incident, "state" | "callId" | "outcome" | "wakeAt" | "offeredActions">
>;

function encodePatchValue(
  value: IncidentPatch[keyof IncidentPatch],
): string | null {
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

export type ActionRun = {
  id: string;
  incidentId: string;
  actionId: string;
  authorizedBy: string | null;
  stateBefore: unknown;
  stateAfter: unknown;
  outcome: "succeeded" | "failed" | "refused";
  detail: string | null;
  at: string;
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
  call_id: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
};

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
        `INSERT INTO incidents (id, state, service, title, severity, detail, fingerprint, source, started_at, links, offered_actions, wake_at, call_id, outcome, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
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
   * Incidents that have sat in one open state longer than that state is allowed to last, oldest
   * first. Every open state is covered, not just the one waiting on a call: an incident that stops
   * anywhere counts as open, and an open incident answers every later repeat of its alert as a
   * duplicate, so any uncovered state is a way to silence a service for good.
   *
   * A snooze is timed by its own deadline rather than by how long ago it was written, because the
   * responder chose that deadline out loud.
   */
  async findStalledIncidents(
    thresholds: { active: string; escalating: string; now: string },
    limit: number,
  ): Promise<Incident[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM incidents
         WHERE (state IN ('received', 'calling', 'deciding', 'acting') AND updated_at < ?1)
            OR (state = 'escalating' AND updated_at < ?2)
            OR (state = 'snoozed' AND wake_at IS NOT NULL AND wake_at <= ?3)
         ORDER BY updated_at ASC LIMIT ?4`,
      )
      .bind(thresholds.active, thresholds.escalating, thresholds.now, limit)
      .all<IncidentRow>();
    return results.map(toIncident);
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
      offeredActions: "offered_actions",
    };

    const assignments: string[] = [];
    const values: (string | null)[] = [];
    for (const key of Object.keys(columns) as (keyof IncidentPatch)[]) {
      if (!(key in patch)) continue;
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
        `INSERT INTO action_runs (id, incident_id, action_id, authorized_by, state_before, state_after, outcome, detail, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        run.id,
        run.incidentId,
        run.actionId,
        run.authorizedBy,
        JSON.stringify(run.stateBefore ?? null),
        JSON.stringify(run.stateAfter ?? null),
        run.outcome,
        run.detail,
        run.at,
      )
      .run();
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
    callId: row.call_id,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
