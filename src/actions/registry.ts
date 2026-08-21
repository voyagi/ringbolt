import type { OfferedAction } from "../domain/incident.js";
import type { Repo, ServiceState } from "../db/repo.js";

export type ActionContext = {
  repo: Repo;
  service: string;
  now: () => Date;
};

export type ActionResult = {
  outcome: "succeeded" | "failed";
  detail: string;
  stateBefore: ServiceState | null;
  stateAfter: ServiceState | null;
};

export type RunbookAction = OfferedAction & {
  run: (context: ActionContext) => Promise<ActionResult>;
};

const DEFAULT_STATE = (service: string, at: string): ServiceState => ({
  service,
  killSwitch: false,
  activeRelease: "current",
  previousRelease: null,
  updatedAt: at,
});

const killSwitch: RunbookAction = {
  id: "kill_switch",
  label: "Turn the feature off",
  spokenDescription:
    "turn the feature off, which stops the failing path immediately and leaves the rest running",
  async run({ repo, service, now }) {
    const at = now().toISOString();
    const before =
      (await repo.getServiceState(service)) ?? DEFAULT_STATE(service, at);
    const after: ServiceState = { ...before, killSwitch: true, updatedAt: at };
    await repo.upsertServiceState(after);
    return {
      outcome: "succeeded",
      detail: `kill switch on for ${service}`,
      stateBefore: before,
      stateAfter: after,
    };
  },
};

const rollback: RunbookAction = {
  id: "rollback",
  label: "Roll back to the previous release",
  spokenDescription:
    "roll back to the previous release, which reverts the code that is running right now",
  confirmationPhrase: "roll it back",
  async run({ repo, service, now }) {
    const at = now().toISOString();
    const before =
      (await repo.getServiceState(service)) ?? DEFAULT_STATE(service, at);

    if (before.previousRelease === null) {
      return {
        outcome: "failed",
        detail: `no previous release is recorded for ${service}, so there is nothing to roll back to`,
        stateBefore: before,
        stateAfter: before,
      };
    }

    const after: ServiceState = {
      ...before,
      activeRelease: before.previousRelease,
      previousRelease: before.activeRelease,
      updatedAt: at,
    };
    await repo.upsertServiceState(after);
    return {
      outcome: "succeeded",
      detail: `${service} moved from ${before.activeRelease} to ${after.activeRelease}`,
      stateBefore: before,
      stateAfter: after,
    };
  },
};

const actions: readonly RunbookAction[] = [killSwitch, rollback];

export function actionsFor(_service: string): readonly RunbookAction[] {
  // Phase 3 replaces this with per-service policy. Until then every service is offered the same
  // two, which is honest: the policy layer does not exist yet rather than existing and being empty.
  return actions;
}

export function findAction(id: string): RunbookAction | undefined {
  return actions.find((action) => action.id === id);
}

export function confirmationPhrasesFor(
  available: readonly RunbookAction[],
): Record<string, string> {
  const phrases: Record<string, string> = {};
  for (const action of available) {
    if (action.confirmationPhrase !== undefined)
      phrases[action.id] = action.confirmationPhrase;
  }
  return phrases;
}
