-- Retention. Until now nothing ever deleted a transcript, so a recording of somebody speaking was
-- kept for as long as the database existed, which is not a retention policy, it is the absence of
-- one.
--
-- The words are erased and the row stays. A call that happened is part of the audit trail behind a
-- production change, and deleting the whole record would leave an action run pointing at a call
-- nobody can account for.
ALTER TABLE call_records ADD COLUMN redacted_at TEXT;

-- Load bearing rather than tidy. Without it an erased transcript reads exactly like the fault this
-- product was built around: a call where the responder was never heard. The screen says which of
-- the two it is looking at, and it can only do that because the row records when the words went.
CREATE INDEX call_records_recorded ON call_records (recorded_at);
