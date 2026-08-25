import type { Repo } from "../db/repo.js";

/**
 * How much one sweep may erase or delete. The cron runs every minute, so a backlog is worked
 * through over several minutes rather than in one request that runs out of time halfway and leaves
 * the estate in a state nobody chose.
 */
const BATCH = 200;

export type RetentionWindows = {
  transcriptDays: number;
  incidentDays: number;
};

export type RetentionResult = {
  /** Calls whose words were erased this sweep. */
  redacted: number;
  /** Closed incidents deleted outright this sweep, with everything hanging off them. */
  deleted: number;
  failed: number;
};

/**
 * The retention sweep, which is the half of a retention policy that a document cannot do.
 *
 * Two windows, because two different things are kept for two different reasons. A transcript is a
 * recording of a person speaking and its purpose ends with the incident, so the words go first and
 * the row stays to say a call happened. A closed incident is the audit trail behind a change to a
 * production system, so it is kept longer and then deleted outright, along with its events, its
 * calls and the actions that ran.
 *
 * Each half is attempted independently. A failure to delete must not stop the erasing, because the
 * erasing is the one with the shorter window and the more personal data in it.
 */
export async function enforceRetention(
  repo: Repo,
  windows: RetentionWindows,
  now: Date,
): Promise<RetentionResult> {
  const result: RetentionResult = { redacted: 0, deleted: 0, failed: 0 };

  try {
    result.redacted = await repo.redactTranscriptsBefore(
      isoDaysBefore(now, windows.transcriptDays),
      now.toISOString(),
      BATCH,
    );
  } catch {
    result.failed += 1;
  }

  try {
    result.deleted = await repo.deleteClosedIncidentsBefore(
      isoDaysBefore(now, windows.incidentDays),
      BATCH,
    );
  } catch {
    result.failed += 1;
  }

  return result;
}

function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
