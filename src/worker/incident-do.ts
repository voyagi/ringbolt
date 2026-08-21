import { DurableObject } from "cloudflare:workers";
import type { VerifiedCall } from "../calle/verify.js";
import type { AlertPayload } from "../domain/incident.js";
import type { OpenResult } from "../domain/orchestrator.js";
import { type Bindings, readConfig } from "./env.js";
import type { IncidentActor } from "./incident-client.js";
import { buildOrchestrator, waitUntilScheduler } from "./wiring.js";

/**
 * One object per incident. Addressing alone is what that buys: every message about an incident is
 * routed to the same instance. It is not, on its own, serialisation. Cloudflare's input gate defers
 * incoming events only while one of the object's OWN storage operations is in flight, and this
 * lifecycle awaits D1 and the call provider rather than ctx.storage, so without the section below
 * two deliveries interleave freely and both act on state neither has written yet.
 *
 * Phase 3 adds the escalation alarm here.
 */
export class IncidentDurableObject
  extends DurableObject<Bindings>
  implements IncidentActor
{
  async open(alert: AlertPayload): Promise<OpenResult> {
    return this.orchestrator().open(alert);
  }

  /**
   * Takes a snapshot already read back from the CALL-E API. The webhook body never reaches here.
   */
  async callTerminal(snapshot: VerifiedCall): Promise<void> {
    await this.orchestrator().onCallTerminal(snapshot);
  }

  async abandonCall(incidentId: string, detail: string): Promise<void> {
    await this.orchestrator().abandonCall(incidentId, detail);
  }

  private orchestrator() {
    const config = readConfig(this.env);
    return buildOrchestrator(this.env, config, {
      scheduler: waitUntilScheduler(this.ctx),
      exclusive: (work) => this.exclusive(work),
    });
  }

  /**
   * blockConcurrencyWhile is the documented way to hold a critical section across awaits that the
   * input gate does not cover. Two details it comes with, both of which shape the callers:
   *
   * A throw out of the callback terminates and resets the object, so an ordinary provider error
   * would take the incident's owner down with it. The callback therefore catches everything and
   * hands the failure back as a value, and this method rethrows it outside the section.
   *
   * The section is also capped at thirty seconds. Everything held inside one is a database
   * read-then-write; placing the call and running the action happen after it has been left.
   */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const outcome = await this.ctx.blockConcurrencyWhile<
      { ok: true; value: T } | { ok: false; error: unknown }
    >(async () => {
      try {
        return { ok: true, value: await work() };
      } catch (error) {
        return { ok: false, error };
      }
    });

    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }
}
