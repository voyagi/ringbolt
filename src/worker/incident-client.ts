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
}

/**
 * One incident is one object, and this is the only place that decides which. Service plus title is
 * the same grouping the fingerprint uses, so a repeat alert reaches the object that is already
 * handling it instead of starting a second one beside it.
 */
export function incidentStub(
  env: Bindings,
  service: string,
  title: string,
): IncidentActor {
  const namespace = env.INCIDENT;
  const stub = namespace.get(namespace.idFromName(`${service}::${title}`));
  return stub as unknown as IncidentActor;
}
