import type { ActionContext } from "../actions/context.js";
import { type RunbookAction, actionsAllowedBy } from "../actions/registry.js";
import {
  type CallPlacer,
  CallNotAttemptedError,
  type CallSnapshot,
  type PlaceCallInput,
  isTerminalCall,
} from "../calle/port.js";
import { type VerifiedCall, verifyCall } from "../calle/verify.js";
import { type Repo, isDuplicateOpenIncident } from "../db/repo.js";
import { buildTask } from "./brief.js";
import {
  type Authorization,
  type Refusal,
  type SpokenDecision,
  authorize,
  decisionResultSchemaFor,
} from "./decision.js";
import {
  type AlertPayload,
  type Incident,
  type IncidentState,
  type WakeReason,
  fingerprintFor,
  transition,
} from "./incident.js";
import {
  type ServicePolicy,
  defaultPolicy,
  quietHoursHold,
  routeAlert,
} from "./policy.js";
import {
  type Contact,
  contactAt,
  effectiveRotation,
  nextInRotation,
} from "./rotation.js";

/**
 * What the timeline says when a call is over: CALL-E's summary when there is one, otherwise the
 * sentence they wrote beside the failure code, which is what explains a call that never connected.
 * On 2026-09-08 a task failed before dialling and the record read "The call ended." while the
 * sentence that explained it, a region their planner had stopped serving, sat unread in the API
 * response. A person reading the incident should not need the API to learn why nobody was called.
 */
function endedMessage(snapshot: CallSnapshot): string {
  if (snapshot.summary !== null) return snapshot.summary;
  const reason = snapshot.failureMessage?.trim() ?? "";
  return reason === "" ? "The call ended." : `The call ended: ${reason}`;
}

/**
 * Runs a read-then-write section with no other message about the same incident interleaving.
 *
 * The incident lifecycle reads a row, decides on it, and writes it back, and every one of those
 * steps awaits the database. Without an enforced section, two deliveries about one incident both
 * read the state before either writes it, and both act on it. On this product that means two phone
 * calls to a real person, or one production change applied twice.
 */
export type Exclusive = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Asks an incident's owner to come back to it at a given time, and to forget a time it no longer
 * needs. In the product this is the Durable Object's alarm, which is the only precise timer
 * available: the cron sweep runs once a minute and is the backstop, not the mechanism.
 */
export type WakeScheduler = {
  schedule: (incidentId: string, at: Date) => Promise<void>;
  clear: (incidentId: string) => Promise<void>;
};

/**
 * What a runbook action needs that is not about the incident: a transport, a timer, the deployment's
 * credentials, and the deployment's own list of hosts it may reach. Required rather than defaulted,
 * for the reason given on ActionContext.
 */
export type ActionEnvironment = Omit<ActionContext, "repo" | "service" | "now">;

export type OrchestratorDeps = {
  repo: Repo;
  placer: CallPlacer;
  publicBaseUrl: string;
  /** Dialled when no rotation has been configured, so a fresh install can still ring somebody. */
  fallbackPhone: string;
  now: () => Date;
  newId: (prefix: string) => string;
  exclusive: Exclusive;
  wake: WakeScheduler;
  actions: ActionEnvironment;
};

export type OpenResult =
  | { kind: "created"; incident: Incident }
  | { kind: "duplicate"; incident: Incident }
  | { kind: "call_failed"; incident: Incident; detail: string };

/** How long a snooze lasts when the responder asked for one without saying how long. */
const DEFAULT_SNOOZE_MINUTES = 30;

/**
 * After this much time on one call, the call is treated as never going to end. The alarm rearms
 * itself while a conversation is genuinely still going, so this is the ceiling on that rearming
 * rather than a limit on how long somebody may talk.
 */
export const GIVE_UP_AFTER_MS = 30 * 60 * 1000;

/**
 * Every way an incident can stop somewhere it cannot leave on its own, and where each one goes.
 * `from` is checked before the move, so a sweep acting on a stale read cannot push an incident that
 * has since moved on. Nothing here is a normal outcome: each is a record for a human to read.
 *
 * The three parked states appear here only for the case where the parking went wrong, which is an
 * incident waiting with no time on it and therefore nothing to wait for. A parked incident that
 * knows when to wake up is woken instead, by the same code the alarm runs.
 */
export const stallResolution = {
  call_never_placed: { from: "received", to: "failed" },
  decision_not_completed: { from: "deciding", to: "escalating" },
  action_outcome_unknown: { from: "acting", to: "failed" },
  escalation_unhandled: { from: "escalating", to: "failed" },
  snooze_lost: { from: "snoozed", to: "failed" },
  deferral_lost: { from: "deferred", to: "failed" },
  mute_lost: { from: "muted", to: "filtered" },
} as const satisfies Record<string, { from: IncidentState; to: IncidentState }>;

export type StallReason = keyof typeof stallResolution;

const stallDetail: Record<StallReason, string> = {
  call_never_placed:
    "The incident was opened but no call was ever confirmed placed, so it is closed. The next repeat of this alert opens a fresh one.",
  decision_not_completed:
    "The call ended but the decision was never carried through, so it goes to the next person in the rotation.",
  action_outcome_unknown:
    "The action started and never reported back. Whether it took effect is unknown, so nothing is retried and this needs a person.",
  escalation_unhandled:
    "This was escalated and the handover never completed, so it is closed rather than left holding the alert.",
  snooze_lost:
    "This was snoozed without a time to wake up at, so nothing was ever going to call back. It is closed and the next repeat of this alert rings again.",
  deferral_lost:
    "This was held for quiet hours without a time to resume at, so nothing was ever going to call. It is closed and the next repeat of this alert rings again.",
  mute_lost:
    "This was suppressed without an end to the suppression window. It is closed, and the next repeat of this alert is judged afresh.",
};

/** What placing a call did. `already_moved` means somebody else got to this incident first. */
type CallOutcome =
  | { kind: "placed"; incident: Incident }
  | { kind: "failed"; incident: Incident; detail: string }
  | { kind: "already_moved"; incident: Incident };

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async open(alert: AlertPayload): Promise<OpenResult> {
    // Nothing may be awaited before this line. The exclusive section has to be entered on the same
    // synchronous turn the message arrived on, or a second message is delivered into the gap and
    // the section it was meant to protect has already been left open.
    const claimed = await this.deps.exclusive(() => this.claim(alert));
    if (claimed.kind !== "created") return claimed;
    return this.route(claimed.incident);
  }

  /**
   * Called when a call has reached a terminal state. It takes a VerifiedCall rather than a call id
   * or a webhook body, so the only way to reach this code is through a snapshot that was read back
   * from the CALL-E API under our own key.
   */
  async onCallTerminal(snapshot: VerifiedCall): Promise<void> {
    // A call that is still running carries no decision. Moving the incident out of `calling` on one
    // would spend its only move out of that state on nothing, and the decision the responder is at
    // that moment giving would then be dropped when it arrives. Both callers get this guard here
    // rather than each keeping their own, which is how the webhook path and the sweep drifted.
    if (!isTerminalCall(snapshot.status)) return;

    const incidentId = incidentIdOf(snapshot);
    if (incidentId === null) return;

    // As in open(), no await before the section is entered.
    const incident = await this.deps.exclusive(() =>
      this.beginDeciding(incidentId),
    );
    if (incident === null) return;

    // This call is over, so the timer that was going to try the next person is not wanted.
    await this.deps.wake.clear(incident.id);

    // The transcript is kept before anything is decided about it, so a refusal has the same
    // evidence behind it as an action does. It is what somebody reads to work out what was heard.
    await this.deps.repo.recordCall({
      callId: snapshot.id,
      incidentId: incident.id,
      contactId: incident.contactId,
      status: snapshot.status,
      taskCompleted: snapshot.taskCompleted,
      confidence: snapshot.confidenceScore,
      summary: snapshot.summary,
      structuredResult: snapshot.structuredResult,
      transcript: snapshot.transcript,
      recordedAt: this.deps.now().toISOString(),
      redactedAt: null,
    });

    await this.record(incident.id, "call.ended", endedMessage(snapshot), {
      status: snapshot.status,
      confidence: snapshot.confidenceScore,
      transcriptTurns: snapshot.transcript.length,
      failureCode: snapshot.failureCode,
      failureMessage: snapshot.failureMessage ?? null,
    });

    const policy = await this.policyFor(incident.service);
    const authorization = authorize({
      callStatus: snapshot.status,
      taskCompleted: snapshot.taskCompleted,
      confidenceScore: snapshot.confidenceScore,
      structuredResult: snapshot.structuredResult,
      transcript: snapshot.transcript,
      offered: await this.stillOffered(incident, policy),
    });

    if (!authorization.authorized) {
      await this.refuse(incident, authorization);
      return;
    }

    await this.runAuthorizedAction(incident, authorization, snapshot.id);
  }

  /**
   * Comes back to an incident that asked to be looked at again. The Durable Object's alarm runs
   * this, and so does the reconciliation sweep when an alarm has been lost, which is why the reason
   * is read off the incident rather than passed in: two callers, one answer.
   *
   * Every branch re-checks the state it expects, so a wake that arrives after the incident has
   * moved on does nothing at all.
   */
  async wake(incidentId: string): Promise<void> {
    const incident = await this.deps.repo.getIncident(incidentId);
    if (incident === null || incident.wakeReason === null) return;

    switch (incident.wakeReason) {
      case "no_answer":
        return this.checkOnCall(incident);
      case "snooze_over":
        return this.callBack(incident);
      case "quiet_hours_over":
        return this.resumeDeferred(incident);
      case "flap_window_over":
        return this.endSuppression(incident);
    }
  }

  /**
   * Gives up on a call that never reached a terminal state, so an incident cannot sit in `calling`
   * for ever after a delivery was lost, and hands the incident to the next person in the rotation.
   */
  async abandonCall(incidentId: string, detail: string): Promise<void> {
    const incident = await this.deps.exclusive(async () => {
      const found = await this.deps.repo.getIncident(incidentId);
      if (found === null || found.state !== "calling") return null;
      const at = this.deps.now().toISOString();
      const state = transition(found.state, "escalating");
      await this.deps.repo.updateIncident(
        found.id,
        {
          state,
          outcome: "call_never_finished",
          wakeAt: null,
          wakeReason: null,
        },
        at,
      );
      return { ...found, state, updatedAt: at };
    });
    if (incident === null) return;

    await this.deps.wake.clear(incident.id);
    await this.record(incident.id, "call.abandoned", detail, {
      callId: incident.callId,
    });
    await this.escalate(incident.id);
  }

  /**
   * Hands an incident nobody resolved to the next person in the rotation, or closes it when the
   * rotation has run out of people. Safe to call twice: placing the call claims the incident first,
   * so a second trigger finds it already calling and stops.
   */
  async escalate(incidentId: string): Promise<void> {
    const incident = await this.deps.repo.getIncident(incidentId);
    if (incident === null || incident.state !== "escalating") return;

    const rotation = await this.rotationFor(incident.service);
    const next = nextInRotation(rotation, incident.rotationPosition);
    if (next === null) {
      await this.rotationExhausted(incident, rotation.length);
      return;
    }

    await this.record(
      incident.id,
      "incident.escalated",
      `Nobody has resolved this, so ${next.name} is being called.`,
      { position: incident.rotationPosition + 1, contact: next.name },
    );
    const policy = await this.policyFor(incident.service);
    await this.placeCall(incident, policy, next, incident.rotationPosition + 1);
  }

  /**
   * Moves an incident that has stopped somewhere it cannot leave on its own into a state it can be
   * seen from, and frees its fingerprint so the next repeat of that alert rings again.
   *
   * It never re-runs anything. Once an incident has stalled, Ringbolt does not know whether the
   * remediation ran, and a product built on never acting on a guess does not get to guess here
   * either. Closing it and naming why is the honest answer; a human reads the record.
   */
  async closeStalled(incidentId: string, reason: StallReason): Promise<void> {
    const incident = await this.deps.exclusive(async () => {
      const found = await this.deps.repo.getIncident(incidentId);
      if (found === null) return null;
      const next = stallResolution[reason];
      if (found.state !== next.from) return null;

      const at = this.deps.now().toISOString();
      const state = transition(found.state, next.to);
      await this.deps.repo.updateIncident(
        found.id,
        { state, outcome: reason, wakeAt: null, wakeReason: null },
        at,
      );
      return { ...found, state, updatedAt: at };
    });
    if (incident === null) return;

    await this.deps.wake.clear(incident.id);
    await this.record(incident.id, "incident.stalled", stallDetail[reason], {
      reason,
      wasIn: stallResolution[reason].from,
    });

    if (incident.state === "escalating") await this.escalate(incident.id);
  }

  /**
   * The whole read-then-write that decides whether this alert is a new incident. It runs inside the
   * exclusive section, and the database's unique index on open fingerprints is the backstop for any
   * path that ever reaches this without one.
   */
  private async claim(alert: AlertPayload): Promise<OpenResult> {
    const fingerprint = fingerprintFor(alert);
    const existing = await this.deps.repo.findOpenByFingerprint(fingerprint);
    if (existing !== null) return this.noteRepeat(existing, alert);

    const at = this.deps.now().toISOString();
    const incident: Incident = {
      id: this.deps.newId("inc"),
      state: "received",
      service: alert.service,
      title: alert.title,
      severity: alert.severity,
      detail: alert.detail ?? null,
      fingerprint,
      source: alert.source ?? null,
      startedAt: alert.startedAt ?? null,
      links: alert.links ?? [],
      offeredActions: [],
      wakeAt: null,
      wakeReason: null,
      callAttempts: 0,
      rotationPosition: 0,
      contactId: null,
      callStartedAt: null,
      createdAt: at,
      updatedAt: at,
      callId: null,
      outcome: null,
    };

    try {
      await this.deps.repo.createIncident(incident);
    } catch (error) {
      if (!isDuplicateOpenIncident(error)) throw error;
      const winner = await this.deps.repo.findOpenByFingerprint(fingerprint);
      if (winner === null) throw error;
      return this.noteRepeat(winner, alert);
    }

    await this.record(
      incident.id,
      "alert.received",
      `${alert.service}: ${alert.title}`,
      { severity: alert.severity },
    );

    return { kind: "created", incident };
  }

  private async noteRepeat(
    incident: Incident,
    alert: AlertPayload,
  ): Promise<OpenResult> {
    await this.record(
      incident.id,
      "alert.duplicate",
      "A repeat of this alert arrived while the incident was open.",
      { title: alert.title },
    );
    return { kind: "duplicate", incident };
  }

  /**
   * The policy decision, and the only place a new incident can turn into a ringing telephone.
   * Everything expensive is read here and handed to routeAlert, which is pure, so the rule that
   * decides whether somebody's phone goes off at three in the morning is testable on its own.
   */
  private async route(incident: Incident): Promise<OpenResult> {
    const policy = await this.policyFor(incident.service);
    const now = this.deps.now();
    const window = await this.deps.repo.callsInWindow(
      incident.fingerprint,
      new Date(now.getTime() - policy.flapWindowMinutes * 60_000).toISOString(),
      incident.id,
    );

    const routing = routeAlert({
      policy,
      severity: incident.severity,
      now,
      recentCalls: window.calls,
      windowOpenedAt:
        window.openedAt === null ? null : new Date(window.openedAt),
    });

    switch (routing.kind) {
      case "call":
        return this.firstCall(incident, policy);
      case "defer":
        return this.park(incident, {
          state: "deferred",
          reason: "quiet_hours_over",
          until: routing.until,
          kind: "incident.deferred",
          message: `Quiet hours are in force for ${incident.service} and a ${incident.severity} alert does not break them, so the call waits.`,
        });
      case "mute":
        return this.park(incident, {
          state: "muted",
          reason: "flap_window_over",
          until: routing.until,
          kind: "incident.muted",
          message: `${incident.service} has already rung a phone about this inside the suppression window, so this repeat does not.`,
        });
      case "filter":
        return this.filterOut(incident, policy);
    }
  }

  private async firstCall(
    incident: Incident,
    policy: ServicePolicy,
  ): Promise<OpenResult> {
    const rotation = await this.rotationFor(incident.service);
    const contact = contactAt(rotation, 0);
    if (contact === null) {
      return this.callCouldNotBePlaced(
        incident,
        new Error("there is nobody to call: the rotation is empty"),
      );
    }

    const outcome = await this.placeCall(incident, policy, contact, 0);
    if (outcome.kind === "failed") {
      return {
        kind: "call_failed",
        incident: outcome.incident,
        detail: outcome.detail,
      };
    }
    return { kind: "created", incident: outcome.incident };
  }

  /**
   * Parks an incident with a time on it. It stays open on purpose: repeats of the same alert
   * collapse into it rather than each becoming a fresh incident, which is the whole point of
   * suppressing a call rather than dropping one.
   */
  private async park(
    incident: Incident,
    parking: {
      state: IncidentState;
      reason: WakeReason;
      until: Date;
      kind: string;
      message: string;
    },
  ): Promise<OpenResult> {
    const at = this.deps.now().toISOString();
    const state = transition(incident.state, parking.state);
    const wakeAt = parking.until.toISOString();

    await this.deps.repo.updateIncident(
      incident.id,
      { state, wakeAt, wakeReason: parking.reason },
      at,
    );
    await this.record(incident.id, parking.kind, parking.message, {
      until: wakeAt,
    });
    await this.deps.wake.schedule(incident.id, parking.until);

    return {
      kind: "created",
      incident: {
        ...incident,
        state,
        wakeAt,
        wakeReason: parking.reason,
        updatedAt: at,
      },
    };
  }

  /** Recorded and closed rather than left open, because nobody is coming back to it. */
  private async filterOut(
    incident: Incident,
    policy: ServicePolicy,
  ): Promise<OpenResult> {
    const at = this.deps.now().toISOString();
    const state = transition(incident.state, "filtered");
    const outcome = "below_severity_threshold";

    await this.deps.repo.updateIncident(incident.id, { state, outcome }, at);
    await this.record(
      incident.id,
      "incident.filtered",
      `${incident.service} is set to call about ${policy.minSeverity} and above. This is ${incident.severity}, so it is on the record and nobody is telephoned.`,
      { minSeverity: policy.minSeverity, severity: incident.severity },
    );

    return {
      kind: "created",
      incident: { ...incident, state, outcome, updatedAt: at },
    };
  }

  /**
   * Rings one telephone. Every path that places a call comes through here: the first call on a new
   * incident, the next person after an escalation, the call back after a snooze, and the call a
   * deferred incident was always going to get once quiet hours ended.
   *
   * The incident is moved into `calling` INSIDE the exclusive section and the call is placed after
   * it, not the other way round. Two triggers can decide to escalate one incident at the same
   * moment, the alarm and the sweep among them, and the second one then finds an incident that is
   * already calling and stops. Placing first would have rung two real phones about one problem.
   *
   * Placing the call itself is deliberately outside the section: it reaches a third party and can
   * take seconds, and holding a Durable Object across that is what the platform's thirty second
   * ceiling on a blocked section exists to discourage.
   */
  private async placeCall(
    incident: Incident,
    policy: ServicePolicy,
    contact: Contact,
    rotationPosition: number,
  ): Promise<CallOutcome> {
    const offered = actionsAllowedBy(
      await this.deps.repo.listActionDefinitions(),
      policy.allowedActions,
    );
    const offeredActions = offered.map((action) => action.id);
    const attempt = incident.callAttempts + 1;
    const startedAt = this.deps.now();
    const deadline = new Date(
      startedAt.getTime() + policy.escalateAfterMinutes * 60_000,
    );

    const claimed = await this.deps.exclusive(async () => {
      const found = await this.deps.repo.getIncident(incident.id);
      // Whether THIS caller made the claim, not what state the incident ended up in. Those are not
      // the same question, and reading the state instead is how a second trigger got through: the
      // state somebody else moves it to is `calling`, so a guard asking "is it calling?" passes at
      // exactly the moment it is supposed to stop. Two triggers escalating one incident at the same
      // moment is the ordinary case here, the alarm and the sweep, and both of them dialled.
      if (found === null || found.state !== incident.state)
        return { mine: false as const, incident: found };

      const state = transition(found.state, "calling");
      const at = startedAt.toISOString();
      await this.deps.repo.updateIncident(
        found.id,
        {
          state,
          callId: null,
          offeredActions,
          callAttempts: attempt,
          rotationPosition,
          contactId: contact.id,
          callStartedAt: at,
          wakeAt: deadline.toISOString(),
          wakeReason: "no_answer",
        },
        at,
      );
      return {
        mine: true as const,
        incident: {
          ...found,
          state,
          callId: null,
          offeredActions,
          callAttempts: attempt,
          rotationPosition,
          contactId: contact.id,
          callStartedAt: at,
          updatedAt: at,
        },
      };
    });

    if (!claimed.mine)
      return { kind: "already_moved", incident: claimed.incident ?? incident };

    return this.dial(claimed.incident, contact, offered, attempt, deadline);
  }

  /**
   * The line that actually rings a telephone, once the incident has been claimed.
   *
   * Everything before this decided whether to call and who to call. This builds the request, sends
   * it, and writes down what happened, in that order for a reason: the call id goes onto the
   * incident first so a delivery arriving immediately can find it, then the audit trail, then the
   * ledger row that both spending guards count. A failure closes the incident rather than leaving
   * it open, because an open incident answers every later repeat of the same alert as a duplicate
   * and the service goes quiet.
   */
  private async dial(
    incident: Incident,
    contact: Contact,
    offered: readonly RunbookAction[],
    attempt: number,
    deadline: Date,
  ): Promise<CallOutcome> {
    const request: PlaceCallInput = {
      phone: contact.phone,
      task: buildTask(incident, offered, this.deps.now()),
      resultSchema: decisionResultSchemaFor(offered),
      metadata: { incident_id: incident.id, service: incident.service },
      webhookUrl: `${this.deps.publicBaseUrl}/webhooks/calle`,
      // One key per attempt, and the same key on every send of that attempt. The next person in the
      // rotation is a different attempt, so their call is not folded into the last one.
      idempotencyKey: `${incident.id}:attempt-${attempt}`,
    };

    let call;
    try {
      call = await this.placeAndRecover(request);
    } catch (error) {
      await this.countUnsettledCall(request, incident.id, error);
      const failed = await this.callCouldNotBePlaced(incident, error);
      return {
        kind: "failed",
        incident: failed.incident,
        detail: failed.kind === "call_failed" ? failed.detail : "unknown",
      };
    }

    const at = this.deps.now().toISOString();
    await this.deps.repo.updateIncident(incident.id, { callId: call.id }, at);
    await this.record(
      incident.id,
      "call.placed",
      `Calling ${contact.name} about ${incident.service}.`,
      {
        callId: call.id,
        placer: this.deps.placer.kind,
        offered: incident.offeredActions,
        contact: contact.name,
        attempt,
      },
    );

    if (this.deps.placer.kind === "live") {
      await this.deps.repo.recordRealCall(call.id, incident.id, at, "live");
    }
    await this.deps.wake.schedule(incident.id, deadline);

    return {
      kind: "placed",
      incident: { ...incident, callId: call.id, updatedAt: at },
    };
  }

  /**
   * Writes down a call that may have been created even though we never got its id.
   *
   * CALL-E bills per call task CREATED, and both of the guards that stop this product spending read
   * the same ledger: the credit ceiling and the ten minute rate limit. A create whose answer never
   * arrived may already have cost five cents and may already be ringing somebody, so counting it as
   * nothing makes both guards blind in the exact failure mode that emptied the balance on
   * 2026-08-22, and blind for every call at once: a provider answering too slowly fails this way
   * for all of them, so the rate limit would never see a single one.
   *
   * The id is made up from the idempotency key rather than left out, so it is stable: the same
   * attempt failing again writes the same row, and `INSERT OR IGNORE` keeps it at one. It cannot
   * collide with a real CALL-E id, which is the point of the prefix.
   *
   * A refusal raised before anything went onto the wire is not counted, and neither is one CALL-E
   * itself rejected: both mean no task exists. That is the same line `callCouldNotBePlaced` draws,
   * on purpose, so the money counted and the record a person reads never disagree.
   */
  private async countUnsettledCall(
    request: PlaceCallInput,
    incidentId: string,
    error: unknown,
  ): Promise<void> {
    if (this.deps.placer.kind !== "live") return;
    if (error instanceof CallNotAttemptedError) return;

    await this.deps.repo.recordRealCall(
      `unsettled:${request.idempotencyKey}`,
      incidentId,
      this.deps.now().toISOString(),
      "live",
    );
  }

  /**
   * Sends the request, and sends the IDENTICAL request once more if the first one failed in a way
   * that could still have created a call.
   *
   * A create that times out is not a create that did not happen. CALL-E confirmed on 2026-08-24
   * that a response which never reaches the client does not cancel a call it already accepted, and
   * that a repeat carrying a DIFFERENT idempotency key is billed as a second, independent call.
   * That is what emptied the balance on 2026-08-22: a timeout, then a fresh key.
   *
   * So the second send carries the same key, which by contract returns the call the first one made
   * rather than making another. It is the only way to learn the id of a call we would otherwise
   * have paid for, never seen, and left ringing somebody's telephone with nothing watching it. A
   * refusal raised before anything went onto the wire is rethrown untouched: there is nothing to
   * recover, and sending it again would only be a second refusal.
   */
  private async placeAndRecover(
    request: PlaceCallInput,
  ): Promise<CallSnapshot> {
    let reachedTheWire: unknown;
    try {
      return await this.deps.placer.place(request);
    } catch (error) {
      if (error instanceof CallNotAttemptedError) throw error;
      reachedTheWire = error;
    }

    try {
      return await this.deps.placer.place(request);
    } catch (error) {
      // The second send being refused does not un-send the first one. The guards run again on the
      // way in, so a concurrent call that took the last of the credit or filled the rate window in
      // between makes this a CallNotAttemptedError, and reporting that one would say nothing
      // reached the provider when something did: the call goes uncounted and a person is told there
      // is nothing to look for. The first failure is the one that classifies this attempt.
      if (error instanceof CallNotAttemptedError) throw reachedTheWire;
      throw error;
    }
  }

  /**
   * A telephone that will not dial has to close the incident rather than leave it. Every open state
   * counts as open, so an incident abandoned here would answer every later repeat of the same alert
   * as a duplicate of itself and no call would ever be placed for that service again.
   *
   * Whether a call exists is recorded rather than assumed. Nothing reached CALL-E when the refusal
   * came from our own guards; anything else got as far as the wire and the second send could not
   * settle it either, so a call may be ringing that this incident will never hear about, and a
   * person needs to know that rather than read "failed" and move on.
   */
  private async callCouldNotBePlaced(
    incident: Incident,
    error: unknown,
  ): Promise<OpenResult> {
    const sent = !(error instanceof CallNotAttemptedError);
    const reported =
      error instanceof Error ? error.message : "the call could not be placed";
    const detail = sent
      ? `${reported}. That attempt reached CALL-E and was never settled, so a call may exist that Ringbolt cannot see and never learned the id of. Check the CALL-E dashboard before trying again.`
      : reported;
    const at = this.deps.now().toISOString();
    const state = transition(incident.state, "failed");
    const outcome = sent ? "call_outcome_unknown" : "call_place_refused";

    await this.deps.repo.updateIncident(
      incident.id,
      { state, outcome, wakeAt: null, wakeReason: null },
      at,
    );
    await this.deps.wake.clear(incident.id);
    await this.record(incident.id, "call.place_failed", detail, {
      placer: this.deps.placer.kind,
      reachedTheProvider: sent,
    });

    return {
      kind: "call_failed",
      incident: { ...incident, state, outcome, updatedAt: at },
      detail,
    };
  }

  /** The call's own deadline has arrived. Read the call rather than assume what happened on it. */
  private async checkOnCall(incident: Incident): Promise<void> {
    if (incident.state !== "calling") return;
    if (incident.callId === null) {
      await this.abandonCall(incident.id, "no call id was ever recorded");
      return;
    }

    let snapshot: VerifiedCall | null = null;
    let detail = "the call could not be read back";
    try {
      snapshot = await verifyCall(this.deps.placer, incident.callId);
      detail = `the call is still ${snapshot.status}`;
    } catch (error) {
      if (error instanceof Error) detail = error.message;
    }

    // Recovery and ordinary operation run the same code: this is the identical snapshot the webhook
    // path would have handed over, so the decision is carried through exactly as it would have been.
    if (snapshot !== null && isTerminalCall(snapshot.status)) {
      await this.onCallTerminal(snapshot);
      return;
    }

    const startedAt = Date.parse(incident.callStartedAt ?? incident.updatedAt);
    if (this.deps.now().getTime() - startedAt >= GIVE_UP_AFTER_MS) {
      await this.abandonCall(incident.id, detail);
      return;
    }

    await this.rearm(incident);
  }

  /**
   * A conversation that is genuinely still going gets more time rather than an escalation. The
   * ceiling on this is GIVE_UP_AFTER_MS, measured from when the call was placed, so rearming cannot
   * push the deadline out for ever.
   */
  private async rearm(incident: Incident): Promise<void> {
    const policy = await this.policyFor(incident.service);
    const now = this.deps.now();
    const deadline = new Date(
      now.getTime() + policy.escalateAfterMinutes * 60_000,
    );

    await this.deps.repo.updateIncident(
      incident.id,
      { wakeAt: deadline.toISOString(), wakeReason: "no_answer" },
      now.toISOString(),
    );
    await this.deps.wake.schedule(incident.id, deadline);
  }

  /** A snooze calls the same person back. They asked for time, not for somebody else. */
  private async callBack(incident: Incident): Promise<void> {
    if (incident.state !== "snoozed") return;

    const rotation = await this.rotationFor(incident.service);
    const contact = contactAt(rotation, incident.rotationPosition);
    if (contact === null) return;

    await this.record(
      incident.id,
      "incident.snooze_ended",
      `The snooze has run out, so ${contact.name} is being called back.`,
      { contact: contact.name },
    );
    const policy = await this.policyFor(incident.service);
    await this.placeCall(incident, policy, contact, incident.rotationPosition);
  }

  private async resumeDeferred(incident: Incident): Promise<void> {
    if (incident.state !== "deferred") return;

    const policy = await this.policyFor(incident.service);
    const now = this.deps.now();

    // Quiet hours end at a wall-clock time, and the deadline was worked out by adding real minutes
    // to a real clock. A daylight-saving change inside the window moves one relative to the other,
    // so the window is asked again rather than trusted, which makes the drift self-correcting
    // instead of a phone call at half past five in the morning.
    const stillQuiet = quietHoursHold(
      policy.quietHours,
      incident.severity,
      now,
    );
    if (stillQuiet !== null) {
      await this.deps.repo.updateIncident(
        incident.id,
        {
          wakeAt: stillQuiet.toISOString(),
          wakeReason: "quiet_hours_over",
        },
        now.toISOString(),
      );
      await this.deps.wake.schedule(incident.id, stillQuiet);
      return;
    }

    const rotation = await this.rotationFor(incident.service);
    const contact = contactAt(rotation, 0);
    if (contact === null) return;

    await this.record(
      incident.id,
      "incident.quiet_hours_ended",
      `Quiet hours are over, so ${contact.name} is being called about this now.`,
      { contact: contact.name },
    );
    await this.placeCall(incident, policy, contact, 0);
  }

  /**
   * The suppression window has closed. The incident ends here rather than turning into a late call:
   * the window exists because this exact problem already rang a phone, and ringing it again an hour
   * afterwards is the behaviour suppression was there to prevent. Closing frees the fingerprint, so
   * the next repeat is judged fresh and rings if it should.
   */
  private async endSuppression(incident: Incident): Promise<void> {
    const moved = await this.deps.exclusive(async () => {
      const found = await this.deps.repo.getIncident(incident.id);
      if (found === null || found.state !== "muted") return false;

      await this.deps.repo.updateIncident(
        found.id,
        {
          state: transition(found.state, "filtered"),
          outcome: "flap_window_ended",
          wakeAt: null,
          wakeReason: null,
        },
        this.deps.now().toISOString(),
      );
      return true;
    });
    if (!moved) return;

    await this.deps.wake.clear(incident.id);
    await this.record(
      incident.id,
      "incident.suppression_ended",
      "The suppression window has closed. Nobody was telephoned about this repeat because the same problem had already rung a phone, and the next repeat is judged afresh.",
      { fingerprint: incident.fingerprint },
    );
  }

  private async rotationExhausted(
    incident: Incident,
    size: number,
  ): Promise<void> {
    const moved = await this.deps.exclusive(async () => {
      const found = await this.deps.repo.getIncident(incident.id);
      if (found === null || found.state !== "escalating") return false;

      await this.deps.repo.updateIncident(
        found.id,
        {
          state: transition(found.state, "failed"),
          outcome: "escalation_exhausted",
          wakeAt: null,
          wakeReason: null,
        },
        this.deps.now().toISOString(),
      );
      return true;
    });
    if (!moved) return;

    await this.deps.wake.clear(incident.id);
    await this.record(
      incident.id,
      "incident.escalation_exhausted",
      `Everybody in the rotation has been tried and nobody resolved this, so it is closed rather than left holding the alert. The next repeat of this alert rings again.`,
      { rotationSize: size },
    );
  }

  private async beginDeciding(incidentId: string): Promise<Incident | null> {
    const incident = await this.deps.repo.getIncident(incidentId);
    if (incident === null || incident.state !== "calling") return null;

    const at = this.deps.now().toISOString();
    const state = transition(incident.state, "deciding");
    await this.deps.repo.updateIncident(
      incident.id,
      { state, wakeAt: null, wakeReason: null },
      at,
    );
    return { ...incident, state, updatedAt: at };
  }

  private async refuse(
    incident: Incident,
    refusal: Refusal<RunbookAction>,
  ): Promise<void> {
    const now = this.deps.now();
    const at = now.toISOString();
    const spoken = refusal.decision;
    const nextState = stateAfterRefusal(refusal);
    const minutes = spoken?.snooze_minutes ?? DEFAULT_SNOOZE_MINUTES;
    // A snooze is the one refusal that names its own deadline, and the alarm needs that deadline as
    // a value rather than as a sentence in the audit trail.
    const wakeAt =
      nextState === "snoozed"
        ? new Date(now.getTime() + minutes * 60_000)
        : null;

    // Refusing to act is a normal outcome, not an error. It always leaves a record naming why,
    // because a human is going to want to know what the system heard.
    await this.deps.repo.updateIncident(
      incident.id,
      {
        state: transition("deciding", nextState),
        outcome:
          spoken === undefined
            ? refusal.refusal
            : `${refusal.refusal}:${spoken.decision}`,
        wakeAt: wakeAt === null ? null : wakeAt.toISOString(),
        wakeReason: wakeAt === null ? null : "snooze_over",
      },
      at,
    );
    await this.record(incident.id, "action.refused", refusal.detail, {
      refusal: refusal.refusal,
      decision: spoken?.decision ?? null,
      snoozeMinutes: nextState === "snoozed" ? minutes : null,
    });

    if (wakeAt !== null) {
      await this.deps.wake.schedule(incident.id, wakeAt);
      return;
    }
    if (nextState === "escalating") await this.escalate(incident.id);
  }

  private async runAuthorizedAction(
    incident: Incident,
    authorization: Extract<Authorization<RunbookAction>, { authorized: true }>,
    callId: string,
  ): Promise<void> {
    const action = authorization.action;
    const startedAt = this.deps.now();
    await this.deps.repo.updateIncident(
      incident.id,
      { state: transition("deciding", "acting") },
      startedAt.toISOString(),
    );

    const authorizer = await this.authorizer(incident);
    const result = await action.run(authorization.parameters, {
      repo: this.deps.repo,
      service: incident.service,
      now: this.deps.now,
      ...this.deps.actions,
    });
    const finished = this.deps.now();

    await this.deps.repo.recordActionRun({
      id: this.deps.newId("run"),
      incidentId: incident.id,
      actionId: action.id,
      callId,
      contactId: incident.contactId,
      authorizedBy: authorizer?.name ?? null,
      decision: authorization.decision,
      parameters: authorization.parameters,
      stateBefore: result.stateBefore,
      stateAfter: result.stateAfter,
      outcome: result.outcome,
      detail: result.detail,
      attempts: result.attempts,
      durationMs: finished.getTime() - startedAt.getTime(),
      verification: result.verification,
      at: finished.toISOString(),
    });

    // Only a checked success resolves an incident. An action that reported success while the check
    // that was supposed to confirm it did not is left open on purpose: telling somebody a
    // production problem is fixed when nobody has looked is the one thing this must never do.
    const nextState = result.outcome === "succeeded" ? "resolved" : "failed";
    await this.deps.repo.updateIncident(
      incident.id,
      {
        state: transition("acting", nextState),
        outcome: `${action.id}:${result.outcome}`,
      },
      finished.toISOString(),
    );
    await this.record(incident.id, `action.${result.outcome}`, result.detail, {
      actionId: action.id,
      attempts: result.attempts,
      verified: result.verification?.verified ?? null,
    });
  }

  /** Who authorized this, by name, so the audit record survives the contact being deleted. */
  private async authorizer(incident: Incident): Promise<Contact | null> {
    if (incident.contactId === null) return null;
    const rotation = await this.rotationFor(incident.service);
    return rotation.find((one) => one.id === incident.contactId) ?? null;
  }

  private async policyFor(service: string): Promise<ServicePolicy> {
    const stored = await this.deps.repo.getServicePolicy(service);
    if (stored !== null) return stored;

    const defined = await this.deps.repo.listActionDefinitions();
    return defaultPolicy(
      service,
      defined.map((definition) => definition.id),
      this.deps.now().toISOString(),
    );
  }

  /**
   * The actions that were read out on this call and are still permitted now. Recomputing the offer
   * at decision time would authorize against a set the responder never heard, which is the same
   * defect as looking an action id up in a different list, one level further out. An intersection is
   * the safe direction on both sides: a policy that has since withdrawn an action cannot run it, and
   * an action added or edited since the call was placed was never on the table.
   */
  private async stillOffered(
    incident: Incident,
    policy: ServicePolicy,
  ): Promise<readonly RunbookAction[]> {
    const spoken = new Set(incident.offeredActions);
    const defined = await this.deps.repo.listActionDefinitions();
    return actionsAllowedBy(defined, policy.allowedActions).filter((action) =>
      spoken.has(action.id),
    );
  }

  private async rotationFor(service: string): Promise<readonly Contact[]> {
    const contacts = await this.deps.repo.rotationFor(service);
    return effectiveRotation(
      contacts,
      this.deps.fallbackPhone,
      this.deps.now().toISOString(),
    );
  }

  private async record(
    incidentId: string,
    kind: string,
    message: string,
    data: unknown,
  ): Promise<void> {
    await this.deps.repo.appendEvent({
      id: this.deps.newId("evt"),
      incidentId,
      at: this.deps.now().toISOString(),
      kind,
      message,
      data,
    });
  }
}

export function incidentIdOf(snapshot: VerifiedCall): string | null {
  const value = snapshot.metadata["incident_id"];
  return typeof value === "string" ? value : null;
}

/**
 * A responder who answered the phone and said "escalate" must not end up somewhere more final than
 * a call nobody picked up. Only an explicit hold is terminal; everything else goes to the rotation,
 * and a snooze keeps its own state so the minutes mean something.
 */
function stateAfterRefusal(refusal: Refusal<RunbookAction>): IncidentState {
  if (refusal.refusal !== "not_an_action_decision") return "escalating";
  return spokenState(refusal.decision);
}

function spokenState(decision: SpokenDecision | undefined): IncidentState {
  switch (decision?.decision) {
    case "hold":
      return "held";
    case "snooze":
      return "snoozed";
    default:
      return "escalating";
  }
}
