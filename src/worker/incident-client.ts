import type { VerifiedCall } from "../calle/verify.js";
import type { AlertPayload } from "../domain/incident.js";
import type { OpenResult } from "../domain/orchestrator.js";
import type { Bindings } from "./env.js";

/**
 * The methods the incident Durable Object exposes. Declared here rather than imported from the
 * class so that the binding type does not have to reach back into the implementation, which would
 * make the worker modules import each other in a circle.
 */
export interface IncidentActor {
  open(alert: AlertPayload): Promise<OpenResult>;
  callTerminal(snapshot: VerifiedCall): Promise<void>;
  abandonCall(incidentId: string, detail: string): Promise<void>;
}

/**
 * One incident is one object, addressed by the incident's fingerprint. That is the same value
 * `fingerprintFor` uses to decide whether an alert is a repeat, so the grouping that says two
 * alerts are one incident and the grouping that gives them one owner cannot disagree. They did:
 * addressing by service and title split any sender that supplies its own fingerprint, which the
 * deploy guide recommends doing, into two objects writing to one incident.
 */
export function incidentStub(
  env: Bindings,
  fingerprint: string,
): IncidentActor {
  const namespace = env.INCIDENT;
  const stub = namespace.get(namespace.idFromName(fingerprint));
  return stub as unknown as IncidentActor;
}
