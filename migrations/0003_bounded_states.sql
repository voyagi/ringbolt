-- When a snoozed incident is due to be looked at again. A responder who says "call me back in
-- forty five minutes" is telling us something with a deadline in it, and an incident that counts as
-- open with no deadline stops every later repeat of that alert from ever ringing a phone.
ALTER TABLE incidents ADD COLUMN wake_at TEXT;

-- The action ids that were actually read out on this call. The authorization gate intersects this
-- with what policy permits at the moment the decision comes back, so an action can only run if it
-- was both offered to the responder and is still allowed. Recomputing the offer at decision time
-- would authorize against a set the responder never heard.
ALTER TABLE incidents ADD COLUMN offered_actions TEXT;

-- Which delivery holds a claim on a webhook event id. Without it, a delivery that stalled long
-- enough to lose its claim still releases on the way out, and deletes the row belonging to the
-- delivery that took over, which quietly stops the id being a deduplication key at all.
ALTER TABLE processed_events ADD COLUMN claim_id TEXT;

CREATE INDEX incidents_snoozed_wake ON incidents (wake_at) WHERE state = 'snoozed';
