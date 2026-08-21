-- Per-service routing policy. A service with no row here is governed by the built-in default, which
-- calls about everything: an install that has configured nothing still telephones somebody, and
-- that is the only default an on-call tool is allowed to have.
CREATE TABLE service_policy (
  service TEXT PRIMARY KEY,
  min_severity TEXT NOT NULL,
  quiet_hours TEXT,
  allowed_actions TEXT NOT NULL,
  flap_window_minutes INTEGER NOT NULL,
  max_calls_per_window INTEGER NOT NULL,
  escalate_after_minutes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- A phone number is personal data, so this table holds the minimum that dialling one needs: who it
-- belongs to and the number itself.
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Who gets called and in what order. '*' is the rotation used by any service that has none of its
-- own, so adding a service does not mean rebuilding the rota.
CREATE TABLE rotation (
  service TEXT NOT NULL,
  position INTEGER NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  PRIMARY KEY (service, position)
);

-- How many calls this incident has already cost. It is what keeps each attempt's idempotency key
-- distinct: a second call, to a second person, must not be deduplicated into the first one.
ALTER TABLE incidents ADD COLUMN call_attempts INTEGER NOT NULL DEFAULT 0;

-- How far down the rotation this incident has got. Escalating moves it; a snooze does not, because
-- "call me back in twenty minutes" means call ME back.
ALTER TABLE incidents ADD COLUMN rotation_position INTEGER NOT NULL DEFAULT 0;

ALTER TABLE incidents ADD COLUMN contact_id TEXT;

-- Why this incident is parked. wake_at says when to come back; this says what to do on arrival. It
-- lives on the incident rather than beside the alarm so the alarm and the reconciliation sweep read
-- one answer instead of two that can disagree.
ALTER TABLE incidents ADD COLUMN wake_reason TEXT;

-- When the current call was placed. The give-up deadline runs on this rather than on updated_at,
-- because the alarm rearms itself while a conversation is still going and every rearm would
-- otherwise push the deadline out again, so a call that never ends would never be given up on.
ALTER TABLE incidents ADD COLUMN call_started_at TEXT;

-- The open set has grown by deferred and muted, and this index is the database's own guarantee that
-- one broken thing is one open incident. It is recreated rather than left alone: an open state
-- missing from it is a second phone call about something already in hand.
DROP INDEX incidents_one_open_per_fingerprint;
CREATE UNIQUE INDEX incidents_one_open_per_fingerprint
  ON incidents (fingerprint)
  WHERE state IN ('received', 'calling', 'deciding', 'acting', 'deferred', 'muted', 'escalating', 'snoozed');

-- Replaces the snooze-only index from migration 0003. Three states are parked with a time on them
-- now, and the sweep that backs up the alarms looks at all of them together.
DROP INDEX incidents_snoozed_wake;
CREATE INDEX incidents_wake ON incidents (wake_at) WHERE wake_at IS NOT NULL;
