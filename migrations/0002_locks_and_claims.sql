-- One open incident per fingerprint, enforced by the database instead of by a read-then-write in
-- application code. Two repeats of the same alert racing each other now collide here rather than
-- becoming two phone calls to the same person at 3am.
CREATE UNIQUE INDEX incidents_one_open_per_fingerprint
  ON incidents (fingerprint)
  WHERE state IN ('received', 'calling', 'deciding', 'acting', 'escalating', 'snoozed');

-- The reconciliation sweep looks for calls that have sat in one state too long.
CREATE INDEX incidents_state_updated ON incidents (state, updated_at);

-- Claiming a webhook event id is two-phase. A delivery marks the id in flight while it works and
-- completes it only once the responder's decision has actually been carried out. A delivery that
-- fails releases its claim, and one whose isolate died leaves a stale in-flight row that the next
-- retry takes over, so a failed delivery can no longer discard a decision permanently.
ALTER TABLE processed_events ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE processed_events ADD COLUMN completed_at TEXT;

CREATE INDEX processed_events_received ON processed_events (received_at);

-- Sent by the monitor and asked about on the call ("how long has this been going on"), so both are
-- stored rather than accepted and dropped. started_at is spoken; links are for the dashboard.
ALTER TABLE incidents ADD COLUMN started_at TEXT;
ALTER TABLE incidents ADD COLUMN links TEXT;
