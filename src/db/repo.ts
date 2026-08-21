import type { Incident, IncidentState, Severity } from "../domain/incident.js";

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
  call_id: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
};

export class Repo {
  constructor(private readonly db: D1Database) {}

  async createIncident(incident: Incident): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO incidents (id, state, service, title, severity, detail, fingerprint, source, call_id, outcome, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
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
         WHERE fingerprint = ?1 AND state IN ('received', 'calling', 'deciding', 'acting', 'escalating')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(fingerprint)
      .first<IncidentRow>();
    return row === null ? null : toIncident(row);
  }

  async updateIncident(
    id: string,
    patch: Partial<Pick<Incident, "state" | "callId" | "outcome">>,
    at: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE incidents
         SET state = COALESCE(?2, state), call_id = COALESCE(?3, call_id), outcome = COALESCE(?4, outcome), updated_at = ?5
         WHERE id = ?1`,
      )
      .bind(
        id,
        patch.state ?? null,
        patch.callId ?? null,
        patch.outcome ?? null,
        at,
      )
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
   * Returns false when this event has been seen before. The insert itself is the lock, so two
   * concurrent deliveries of the same event cannot both win.
   */
  async claimEvent(eventId: string, at: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_events (event_id, received_at) VALUES (?1, ?2)`,
      )
      .bind(eventId, at)
      .run();
    return (result.meta.changes ?? 0) > 0;
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
    callId: row.call_id,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
