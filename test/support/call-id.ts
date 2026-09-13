import { Repo } from "../../src/db/repo.js";

/**
 * The id of the call the incident is currently waiting on.
 *
 * A hand-built snapshot has to carry this rather than an invented id. `beginDeciding` compares the
 * arriving snapshot's id against the incident's own, because the incident state alone does not say
 * WHICH call, and a delivery for a call the incident has moved on from must not be judged against
 * the current one. Three test files each used to make up an id of their own shape
 * (`call_stub`, `call_stub_<incident>`), which was harmless only while nothing compared them, and
 * which meant those tests were driving a state the product cannot reach.
 *
 * It lives here rather than in each file so a fourth test cannot quietly reintroduce the made-up
 * id, and so there is one place to change if the comparison ever moves.
 */
export async function callIdWaitingOn(
  db: D1Database,
  incidentId: string,
): Promise<string> {
  const incident = await new Repo(db).getIncident(incidentId);
  if (incident === null) {
    throw new Error(`no incident ${incidentId} to read a call id from`);
  }
  if (incident.callId === null) {
    throw new Error(
      `incident ${incidentId} is not waiting on a call, so a terminal snapshot for it is not a state this product reaches`,
    );
  }
  return incident.callId;
}
