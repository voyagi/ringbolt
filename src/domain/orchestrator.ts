import { type RunbookAction, actionsFor } from "../actions/registry.js";
import { type CallPlacer, isTerminalCall } from "../calle/port.js";
import type { VerifiedCall } from "../calle/verify.js";
import { type Repo, isDuplicateOpenIncident } from "../db/repo.js";
import {
  type Refusal,
  type SpokenDecision,
  authorize,
  decisionResultSchema,
} from "./decision.js";
import {
  type AlertPayload,
  type Incident,
  type IncidentState,
  type OfferedAction,
  describeForSpeech,
  fingerprintFor,
  transition,
} from "./incident.js";

/**
 * Runs a read-then-write section with no other message about the same incident interleaving.
 *
 * The incident lifecycle reads a row, decides on it, and writes it back, and every one of those
 * steps awaits the database. Without an enforced section, two deliveries about one incident both
 * read the state before either writes it, and both act on it. On this product that means two phone
 * calls to a real person, or one production change applied twice.
 */
export type Exclusive = <T>(work: () => Promise<T>) => Promise<T>;

export type OrchestratorDeps = {
  repo: Repo;
  placer: CallPlacer;
  publicBaseUrl: string;
  responderPhone: string;
  now: () => Date;
  newId: (prefix: string) => string;
  exclusive: Exclusive;
};

export type OpenResult =
  | { kind: "created"; incident: Incident }
  | { kind: "duplicate"; incident: Incident }
  | { kind: "call_failed"; incident: Incident; detail: string };

/** How long a snooze lasts when the responder asked for one without saying how long. */
const DEFAULT_SNOOZE_MINUTES = 30;

/**
 * Every way an incident can stop somewhere it cannot leave on its own, and where each one goes.
 * `from` is checked before the move, so a sweep acting on a stale read cannot push an incident that
 * has since moved on. Nothing here is a normal outcome: each is a record for a human to read.
 */
export const stallResolution = {
  call_never_placed: { from: "received", to: "failed" },
  decision_not_completed: { from: "deciding", to: "escalating" },
  action_outcome_unknown: { from: "acting", to: "failed" },
  escalation_unhandled: { from: "escalating", to: "failed" },
  snooze_expired: { from: "snoozed", to: "failed" },
} as const satisfies Record<string, { from: IncidentState; to: IncidentState }>;

export type StallReason = keyof typeof stallResolution;

const stallDetail: Record<StallReason, string> = {
  call_never_placed:
    "The incident was opened but no call was ever confirmed placed, so it is closed. The next repeat of this alert opens a fresh one.",
  decision_not_completed:
    "The call ended but the decision was never carried through, so this needs a person.",
  action_outcome_unknown:
    "The action started and never reported back. Whether it took effect is unknown, so nothing is retried and this needs a person.",
  escalation_unhandled:
    "This was escalated and nobody picked it up. There is no rotation to hand it to yet, so it is closed rather than left holding the alert.",
  snooze_expired:
    "The snooze ran out. Calling back is the rotation's job and that is not built, so it is closed and the next repeat of this alert rings again.",
};

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async open(alert: AlertPayload): Promise<OpenResult> {
    // Nothing may be awaited before this line. The exclusive section has to be entered on the same
    // synchronous turn the message arrived on, or a second message is delivered into the gap and
    // the section it was meant to protect has already been left open.
    const claimed = await this.deps.exclusive(() => this.claim(alert));
    if (claimed.kind !== "created") return claimed;
    return this.startCall(claimed.incident);
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

    await this.record(
      incident.id,
      "call.ended",
      snapshot.summary ?? "The call ended.",
      {
        status: snapshot.status,
        confidence: snapshot.confidenceScore,
        transcriptTurns: snapshot.transcript.length,
      },
    );

    const authorization = authorize({
      callStatus: snapshot.status,
      taskCompleted: snapshot.taskCompleted,
      confidenceScore: snapshot.confidenceScore,
      structuredResult: snapshot.structuredResult,
      offered: stillOffered(incident),
    });

    if (!authorization.authorized) {
      await this.refuse(incident, authorization);
      return;
    }

    await this.runAuthorizedAction(incident, authorization.action, snapshot.id);
  }

  /**
   * Gives up on a call that never reached a terminal state, so an incident cannot sit in `calling`
   * for ever after a delivery was lost. Driven by the reconciliation sweep, never by a webhook.
   */
  async abandonCall(incidentId: string, detail: string): Promise<void> {
    const incident = await this.deps.exclusive(async () => {
      const found = await this.deps.repo.getIncident(incidentId);
      if (found === null || found.state !== "calling") return null;
      const at = this.deps.now().toISOString();
      const state = transition(found.state, "escalating");
      await this.deps.repo.updateIncident(
        found.id,
        { state, outcome: "call_never_finished" },
        at,
      );
      return { ...found, state, updatedAt: at };
    });
    if (incident === null) return;

    await this.record(incident.id, "call.abandoned", detail, {
      callId: incident.callId,
    });
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

  private async beginDeciding(incidentId: string): Promise<Incident | null> {
    const incident = await this.deps.repo.getIncident(incidentId);
    if (incident === null || incident.state !== "calling") return null;

    const at = this.deps.now().toISOString();
    const state = transition(incident.state, "deciding");
    await this.deps.repo.updateIncident(incident.id, { state }, at);
    return { ...incident, state, updatedAt: at };
  }

  /**
   * Deliberately outside the exclusive section. Placing a call reaches a third party and can take
   * seconds, the incident row is already claimed by the time it runs, and holding a Durable Object
   * across an external call is what the platform's thirty second ceiling on a blocked section is
   * there to discourage.
   */
  private async startCall(incident: Incident): Promise<OpenResult> {
    const offered = actionsFor(incident.service);
    const at = this.deps.now().toISOString();

    let call;
    try {
      call = await this.deps.placer.place({
        phone: this.deps.responderPhone,
        task: buildTask(incident, offered, this.deps.now()),
        resultSchema: decisionResultSchema as unknown as Record<
          string,
          unknown
        >,
        metadata: { incident_id: incident.id, service: incident.service },
        webhookUrl: `${this.deps.publicBaseUrl}/webhooks/calle`,
        // One call per incident attempt. A retried place cannot become a second ringing phone.
        idempotencyKey: `${incident.id}:attempt-1`,
      });
    } catch (error) {
      return this.callCouldNotBePlaced(incident, error);
    }

    const state = transition(incident.state, "calling");
    const offeredActions = offered.map((action) => action.id);
    await this.deps.repo.updateIncident(
      incident.id,
      { state, callId: call.id, offeredActions },
      at,
    );
    await this.record(
      incident.id,
      "call.placed",
      `Calling the responder about ${incident.service}.`,
      {
        callId: call.id,
        placer: this.deps.placer.kind,
        offered: offeredActions,
      },
    );

    if (this.deps.placer.kind === "live") {
      await this.deps.repo.recordRealCall(call.id, incident.id, at, "live");
    }

    return {
      kind: "created",
      incident: {
        ...incident,
        state,
        callId: call.id,
        offeredActions,
        updatedAt: at,
      },
    };
  }

  /**
   * A telephone that will not dial has to close the incident rather than leave it. `received`
   * counts as open, so an incident abandoned here would answer every later repeat of the same
   * alert as a duplicate of itself and no call would ever be placed for that service again.
   */
  private async callCouldNotBePlaced(
    incident: Incident,
    error: unknown,
  ): Promise<OpenResult> {
    const detail =
      error instanceof Error ? error.message : "the call could not be placed";
    const at = this.deps.now().toISOString();
    const state = transition(incident.state, "failed");

    await this.deps.repo.updateIncident(
      incident.id,
      { state, outcome: "call_place_failed" },
      at,
    );
    await this.record(incident.id, "call.place_failed", detail, {
      placer: this.deps.placer.kind,
    });

    return {
      kind: "call_failed",
      incident: { ...incident, state, updatedAt: at },
      detail,
    };
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
        // A snooze is the one refusal that names its own deadline, and the sweep needs that
        // deadline as a value rather than as a sentence in the audit trail.
        wakeAt:
          nextState === "snoozed"
            ? new Date(now.getTime() + minutes * 60_000).toISOString()
            : null,
      },
      at,
    );
    await this.record(incident.id, "action.refused", refusal.detail, {
      refusal: refusal.refusal,
      decision: spoken?.decision ?? null,
      snoozeMinutes: nextState === "snoozed" ? minutes : null,
    });
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
        { state, outcome: reason, wakeAt: null },
        at,
      );
      return { ...found, state, updatedAt: at };
    });
    if (incident === null) return;

    await this.record(incident.id, "incident.stalled", stallDetail[reason], {
      reason,
      wasIn: stallResolution[reason].from,
    });
  }

  private async runAuthorizedAction(
    incident: Incident,
    action: RunbookAction,
    callId: string,
  ): Promise<void> {
    const at = this.deps.now().toISOString();
    await this.deps.repo.updateIncident(
      incident.id,
      { state: transition("deciding", "acting") },
      at,
    );

    const result = await action.run({
      repo: this.deps.repo,
      service: incident.service,
      now: this.deps.now,
    });
    const finishedAt = this.deps.now().toISOString();

    await this.deps.repo.recordActionRun({
      id: this.deps.newId("run"),
      incidentId: incident.id,
      actionId: action.id,
      authorizedBy: callId,
      stateBefore: result.stateBefore,
      stateAfter: result.stateAfter,
      outcome: result.outcome,
      detail: result.detail,
      at: finishedAt,
    });

    const nextState = result.outcome === "succeeded" ? "resolved" : "failed";
    await this.deps.repo.updateIncident(
      incident.id,
      {
        state: transition("acting", nextState),
        outcome: `${action.id}:${result.outcome}`,
      },
      finishedAt,
    );
    await this.record(incident.id, `action.${result.outcome}`, result.detail, {
      actionId: action.id,
    });
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
 * The actions that were read out on this call and are still permitted now. Recomputing the offer at
 * decision time would authorize against a set the responder never heard, which is the same defect
 * as looking an action id up in a different list, one level further out. An intersection is the
 * safe direction on both sides: a policy that has since withdrawn an action cannot run it, and an
 * action added since the call was placed was never on the table.
 */
function stillOffered(incident: Incident): readonly RunbookAction[] {
  const spoken = new Set(incident.offeredActions);
  return actionsFor(incident.service).filter((action) => spoken.has(action.id));
}

/**
 * A responder who answered the phone and said "escalate" must not end up somewhere more final than
 * a call nobody picked up. Only an explicit hold is terminal; everything else stays reachable by
 * the rotation phase 3 builds, and a snooze keeps its own state so the minutes mean something.
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

function buildTask(
  incident: Incident,
  offered: readonly OfferedAction[],
  now: Date,
): string {
  const choices = offered
    .map((action) => {
      const confirmation =
        action.confirmationPhrase === undefined
          ? ""
          : ` Before doing this one, ask them to say the exact words "${action.confirmationPhrase}" and record what they said.`;
      return `- ${action.id}: ${action.spokenDescription}.${confirmation}`;
    })
    .join("\n");

  return [
    "You are calling the engineer who is on call, about a live production problem.",
    "Open by saying who is calling and what has broken, in one sentence, then stop and let them respond.",
    "",
    describeForSpeech(incident, now),
    "",
    "Answer their questions about the incident using only the facts above. If they ask something you were not told, say plainly that you do not have that detail.",
    "",
    "These are the only things you can do for them:",
    choices,
    "- hold: change nothing for now.",
    "- escalate: hand this to someone else.",
    "- snooze: leave it and call back later, and ask how many minutes.",
    "",
    "Read the choices out only if they ask what you can do, or if they have not decided after their questions are answered. Do not push them.",
    "Before ending the call, say back what you understood the decision to be and get a yes.",
  ].join("\n");
}
