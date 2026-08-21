import {
  actionsFor,
  confirmationPhrasesFor,
  findAction,
} from "../actions/registry.js";
import type { CallPlacer } from "../calle/port.js";
import type { VerifiedCall } from "../calle/verify.js";
import type { Repo } from "../db/repo.js";
import { authorize, decisionResultSchema } from "./decision.js";
import {
  type AlertPayload,
  type Incident,
  type OfferedAction,
  describeForSpeech,
  fingerprintFor,
  transition,
} from "./incident.js";

export type OrchestratorDeps = {
  repo: Repo;
  placer: CallPlacer;
  publicBaseUrl: string;
  responderPhone: string;
  now: () => Date;
  newId: (prefix: string) => string;
};

export type OpenResult =
  | { kind: "created"; incident: Incident }
  | { kind: "duplicate"; incident: Incident };

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async open(alert: AlertPayload): Promise<OpenResult> {
    const fingerprint = fingerprintFor(alert);
    const existing = await this.deps.repo.findOpenByFingerprint(fingerprint);
    if (existing !== null) {
      await this.record(
        existing.id,
        "alert.duplicate",
        "A repeat of this alert arrived while the incident was open.",
        {
          title: alert.title,
        },
      );
      return { kind: "duplicate", incident: existing };
    }

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
      createdAt: at,
      updatedAt: at,
      callId: null,
      outcome: null,
    };

    await this.deps.repo.createIncident(incident);
    await this.record(
      incident.id,
      "alert.received",
      `${alert.service}: ${alert.title}`,
      { severity: alert.severity },
    );

    return { kind: "created", incident: await this.placeCall(incident) };
  }

  private async placeCall(incident: Incident): Promise<Incident> {
    const offered = actionsFor(incident.service);
    const at = this.deps.now().toISOString();

    const call = await this.deps.placer.place({
      phone: this.deps.responderPhone,
      task: buildTask(incident, offered),
      resultSchema: decisionResultSchema as unknown as Record<string, unknown>,
      metadata: { incident_id: incident.id, service: incident.service },
      webhookUrl: `${this.deps.publicBaseUrl}/webhooks/calle`,
      // One call per incident attempt. A retried place cannot become a second ringing phone.
      idempotencyKey: `${incident.id}:attempt-1`,
    });

    const state = transition(incident.state, "calling");
    await this.deps.repo.updateIncident(
      incident.id,
      { state, callId: call.id },
      at,
    );
    await this.record(
      incident.id,
      "call.placed",
      `Calling the responder about ${incident.service}.`,
      {
        callId: call.id,
        placer: this.deps.placer.kind,
        offered: offered.map((action) => action.id),
      },
    );

    if (this.deps.placer.kind === "live") {
      await this.deps.repo.recordRealCall(call.id, incident.id, at, "live");
    }

    return { ...incident, state, callId: call.id, updatedAt: at };
  }

  /**
   * Called when a call has reached a terminal state. It takes a VerifiedCall rather than a call id
   * or a webhook body, so the only way to reach this code is through a snapshot that was read back
   * from the CALL-E API under our own key.
   */
  async onCallTerminal(snapshot: VerifiedCall): Promise<void> {
    const incidentId =
      typeof snapshot.metadata["incident_id"] === "string"
        ? snapshot.metadata["incident_id"]
        : null;
    if (incidentId === null) return;

    const incident = await this.deps.repo.getIncident(incidentId);
    if (incident === null || incident.state !== "calling") return;

    const at = this.deps.now().toISOString();
    await this.deps.repo.updateIncident(
      incident.id,
      { state: transition(incident.state, "deciding") },
      at,
    );
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

    const offered = actionsFor(incident.service);
    const authorization = authorize({
      callStatus: snapshot.status,
      taskCompleted: snapshot.taskCompleted,
      confidenceScore: snapshot.confidenceScore,
      structuredResult: snapshot.structuredResult,
      offeredActionIds: offered.map((action) => action.id),
      confirmationPhrases: confirmationPhrasesFor(offered),
    });

    if (!authorization.authorized) {
      await this.refuse(incident, authorization.refusal, authorization.detail);
      return;
    }

    await this.runAuthorizedAction(
      incident,
      authorization.actionId,
      snapshot.id,
    );
  }

  private async refuse(
    incident: Incident,
    refusal: string,
    detail: string,
  ): Promise<void> {
    const at = this.deps.now().toISOString();
    // Refusing to act is a normal outcome, not an error. It always leaves a record naming why,
    // because a human is going to want to know what the system heard.
    const nextState =
      refusal === "not_an_action_decision" ? "held" : "escalating";
    await this.deps.repo.updateIncident(
      incident.id,
      { state: transition("deciding", nextState), outcome: refusal },
      at,
    );
    await this.record(incident.id, "action.refused", detail, { refusal });
  }

  private async runAuthorizedAction(
    incident: Incident,
    actionId: string,
    callId: string,
  ): Promise<void> {
    const action = findAction(actionId);
    if (action === undefined) {
      await this.refuse(
        incident,
        "action_not_offered",
        `${actionId} is not a known action`,
      );
      return;
    }

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
      actionId,
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
        outcome: `${actionId}:${result.outcome}`,
      },
      finishedAt,
    );
    await this.record(incident.id, `action.${result.outcome}`, result.detail, {
      actionId,
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

function buildTask(
  incident: Incident,
  offered: readonly OfferedAction[],
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
    describeForSpeech(incident),
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
