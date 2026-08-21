import { DurableObject } from "cloudflare:workers";
import type { VerifiedCall } from "../calle/verify.js";
import type { AlertPayload } from "../domain/incident.js";
import type { OpenResult } from "../domain/orchestrator.js";
import { type Bindings, readConfig } from "./env.js";
import type { IncidentActor } from "./incident-client.js";
import { buildOrchestrator, waitUntilScheduler } from "./wiring.js";

/**
 * One object per incident, which is what makes the lifecycle safe to reason about: every message
 * about a given incident is handled by the same single-threaded owner, so a webhook arriving while
 * a call is still being placed queues behind it instead of racing it.
 *
 * Phase 3 adds the escalation alarm here. The class exists in phase 1 so the wiring is proven
 * rather than assumed.
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

  private orchestrator() {
    const config = readConfig(this.env);
    return buildOrchestrator(this.env, config, {
      scheduler: waitUntilScheduler(this.ctx),
    });
  }
}
