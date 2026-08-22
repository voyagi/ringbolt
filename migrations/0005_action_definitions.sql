-- Runbook actions as configuration. Until now the two Ringbolt could carry out were functions in
-- the source, so adding one meant a deploy and an operator could only choose between them. A row
-- here is the whole definition: what it is called, what the caller says about it out loud, what
-- must be said back before it runs, the parameters it accepts, what it actually does, and how to
-- check afterwards that it worked.
CREATE TABLE action_definitions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  spoken_description TEXT NOT NULL,
  -- The exact words a responder has to say for this one. Null means it is not destructive enough
  -- to need them.
  confirmation_phrase TEXT,
  -- A floor of its own, for an action that deserves more certainty than the product-wide one. Null
  -- means the product-wide floor is the whole test.
  min_confidence REAL,
  parameters TEXT NOT NULL DEFAULT '[]',
  target TEXT NOT NULL,
  verify TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The audit trail has to answer who authorized what, on which call, with which values, and whether
-- anybody checked that it took effect. It could answer none of those.
ALTER TABLE action_runs ADD COLUMN call_id TEXT;
ALTER TABLE action_runs ADD COLUMN contact_id TEXT;
ALTER TABLE action_runs ADD COLUMN decision TEXT;
ALTER TABLE action_runs ADD COLUMN parameters TEXT;
ALTER TABLE action_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE action_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE action_runs ADD COLUMN verification TEXT;

-- What was actually said on the call. It is the evidence behind the decision, so it is kept beside
-- the decision rather than left in CALL-E's records, where it expires on their retention schedule
-- and cannot be read without their API. A transcript is personal data: this table is why the audit
-- endpoint is behind the admin token rather than on the open read API, and phase 7 gives it a
-- retention window and a deletion path.
CREATE TABLE call_records (
  call_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  contact_id TEXT,
  status TEXT NOT NULL,
  task_completed INTEGER,
  confidence REAL,
  summary TEXT,
  structured_result TEXT,
  transcript TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX call_records_incident ON call_records (incident_id, recorded_at);

-- The two that were hardcoded, now rows like any other. They are seeded rather than assumed by the
-- code so that a fresh install can still offer something on the first call it places, and so that
-- an operator can edit or remove them without a deploy.
INSERT INTO action_definitions (id, label, spoken_description, confirmation_phrase, min_confidence, parameters, target, verify, created_at, updated_at)
VALUES (
  'kill_switch',
  'Turn the feature off',
  'turn the feature off, which stops the failing path immediately and leaves the rest running',
  NULL,
  NULL,
  '[]',
  '{"kind":"service_state","operation":"kill_switch_on"}',
  NULL,
  '2026-08-22T00:00:00.000Z',
  '2026-08-22T00:00:00.000Z'
);

INSERT INTO action_definitions (id, label, spoken_description, confirmation_phrase, min_confidence, parameters, target, verify, created_at, updated_at)
VALUES (
  'rollback',
  'Roll back to the previous release',
  'roll back to the previous release, which reverts the code that is running right now',
  'roll it back',
  0.8,
  '[{"name":"release","description":"which release to go back to, if they name one rather than saying just go back","type":"string","required":false,"maxLength":80}]',
  '{"kind":"service_state","operation":"rollback"}',
  NULL,
  '2026-08-22T00:00:00.000Z',
  '2026-08-22T00:00:00.000Z'
);
