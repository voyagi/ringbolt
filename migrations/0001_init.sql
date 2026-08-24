CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT,
  fingerprint TEXT NOT NULL,
  source TEXT,
  call_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX incidents_state_created ON incidents (state, created_at DESC);
CREATE INDEX incidents_fingerprint_open ON incidents (fingerprint, created_at DESC);

-- The audit trail. Append only by convention: nothing in the application updates or deletes a row
-- here, because an incident record that can be edited afterwards is not evidence of anything.
CREATE TABLE incident_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);

CREATE INDEX incident_events_incident_at ON incident_events (incident_id, at);

-- State that Ringbolt owns and that monitored services read, so a remediation action changes
-- something real and verifiable rather than being reported as done.
CREATE TABLE service_state (
  service TEXT PRIMARY KEY,
  kill_switch INTEGER NOT NULL DEFAULT 0,
  active_release TEXT NOT NULL DEFAULT 'current',
  previous_release TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE action_runs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  action_id TEXT NOT NULL,
  authorized_by TEXT,
  state_before TEXT,
  state_after TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE INDEX action_runs_incident ON action_runs (incident_id, at);

-- CALL-E delivers webhooks at least once, so the event id is the deduplication key.
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- CALL-E bills per call task created, so spending is counted rather than estimated. One row per
-- real call placed. (This comment said "the free tier is 20 real calls" until 2026-08-24, when the
-- provider confirmed the unit is money at five cents a task, connected or not.)
CREATE TABLE call_ledger (
  call_id TEXT PRIMARY KEY,
  incident_id TEXT,
  placed_at TEXT NOT NULL,
  placer TEXT NOT NULL
);

-- The local stand-in for CALL-E stores its calls here rather than in memory. A Durable Object and
-- the Worker that receives the webhook run in different isolates, so an in-memory fake would be
-- invisible to the code that has to read the call back, which is exactly the path being tested.
CREATE TABLE fake_calls (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
