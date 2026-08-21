import { DurableObject } from "cloudflare:workers";
import type { VerifiedCall } from "../calle/verify.js";
import type { AlertPayload } from "../domain/incident.js";
import type { OpenResult, StallReason } from "../domain/orchestrator.js";
import { type Bindings, readConfig } from "./env.js";
import type { IncidentActor } from "./incident-client.js";
import { buildOrchestrator, waitUntilScheduler } from "./wiring.js";

/**
 * The one thing this object keeps in its own storage: which incident its alarm belongs to. Why the
 * alarm was set is on the incident row instead, so the alarm and the reconciliation sweep that
 * backs it up read one answer rather than two that can disagree.
 */
const WAKE_KEY = "wake";

type PendingWake = { incidentId: string };

/**
 * One object per incident. Addressing alone is what that buys: every message about an incident is
 * routed to the same instance. It is not, on its own, serialisation. Cloudflare's input gate defers
 * incoming events only while one of the object's OWN storage operations is in flight, and this
 * lifecycle awaits D1 and the call provider rather than ctx.storage, so without the section below
 * two deliveries interleave freely and both act on state neither has written yet.
 *
 * The alarm is the second thing an object buys, and it is the only precise timer Ringbolt has. The
 * cron sweep runs once a minute and covers a lost alarm; escalating on no answer, calling back
 * after a snooze, and resuming after quiet hours are all driven from here.
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

  async closeStalled(incidentId: string, reason: StallReason): Promise<void> {
    await this.orchestrator().closeStalled(incidentId, reason);
  }

  async wake(incidentId: string): Promise<void> {
    await this.orchestrator().wake(incidentId);
  }

  /**
   * The scheduled time has arrived. The key is cleared before the work runs rather than after,
   * because the work usually sets the next alarm itself, and deleting afterwards would throw that
   * one away. An alarm that fires with nothing recorded is not an error: it is what a cancelled
   * wake looks like when the platform had already committed to delivering it.
   */
  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<PendingWake>(WAKE_KEY);
    if (pending === undefined) return;
    await this.ctx.storage.delete(WAKE_KEY);
    await this.orchestrator().wake(pending.incidentId);
  }

  private orchestrator() {
    const config = readConfig(this.env);
    return buildOrchestrator(this.env, config, {
      scheduler: waitUntilScheduler(this.ctx),
      exclusive: (work) => this.exclusive(work),
      wake: {
        schedule: (incidentId, at) => this.scheduleWake(incidentId, at),
        clear: (incidentId) => this.clearWake(incidentId),
      },
    });
  }

  private async scheduleWake(incidentId: string, at: Date): Promise<void> {
    await this.ctx.storage.put<PendingWake>(WAKE_KEY, { incidentId });
    await this.ctx.storage.setAlarm(at);
  }

  /**
   * Only the incident that owns the pending wake may cancel it. This object outlives any one
   * incident, since it is addressed by the fingerprint they share, so a finished incident dropping
   * whatever alarm it happened to find would silently disarm its successor.
   */
  private async clearWake(incidentId: string): Promise<void> {
    const pending = await this.ctx.storage.get<PendingWake>(WAKE_KEY);
    if (pending?.incidentId !== incidentId) return;
    await this.ctx.storage.delete(WAKE_KEY);
    await this.ctx.storage.deleteAlarm();
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
