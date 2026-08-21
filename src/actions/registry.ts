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

/**
 * The only way into this list, and it takes the ids a service's policy permits rather than the
 * service name. The authorization gate runs the action objects this returns rather than looking an
 * id up in the module again, so narrowing the permitted set here narrows what can actually run.
 */
export function actionsAllowedBy(
  allowed: readonly string[],
): readonly RunbookAction[] {
  const permitted = new Set(allowed);
  return actions.filter((action) => permitted.has(action.id));
}

/** Everything the product can do, for the default policy and for the configuration screens. */
export function allActionIds(): readonly string[] {
  return actions.map((action) => action.id);
}

export function describeActions(): readonly OfferedAction[] {
  return actions.map(({ run: _unused, ...offered }) => offered);
}
