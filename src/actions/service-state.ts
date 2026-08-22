import type { ServiceState } from "../db/repo.js";
import type { ActionContext, ActionResult } from "./context.js";
import type { ParameterValue, ServiceStateOperation } from "./definition.js";

/**
 * The operations on state Ringbolt owns. They exist so a runbook action can be demonstrated end to
 * end without a third party's credential, and so the demo service has something real to break.
 *
 * Every one of them reads the state back after writing it and compares it to what it meant to do.
 * That check is not configurable, unlike the one an http action declares, because there is nothing
 * to configure: the intended state is known here.
 */
export async function runServiceState(
  operation: ServiceStateOperation,
  values: Readonly<Record<string, ParameterValue>>,
  context: ActionContext,
): Promise<ActionResult> {
  const at = context.now().toISOString();
  const before =
    (await context.repo.getServiceState(context.service)) ??
    initialState(context.service, at);

  const intended = apply(operation, before, values, at);
  if (typeof intended === "string") {
    return {
      outcome: "failed",
      detail: intended,
      stateBefore: before,
      stateAfter: before,
      attempts: 1,
      verification: null,
    };
  }

  await context.repo.upsertServiceState(intended);
  const after = await context.repo.getServiceState(context.service);
  const verified =
    after !== null &&
    after.killSwitch === intended.killSwitch &&
    after.activeRelease === intended.activeRelease;

  return {
    outcome: verified ? "succeeded" : "unverified",
    detail: describe(operation, before, intended),
    stateBefore: before,
    stateAfter: after,
    attempts: 1,
    verification: {
      verified,
      detail: verified
        ? `${context.service} reads back as it was set`
        : `${context.service} was written but does not read back as intended`,
    },
  };
}

function initialState(service: string, at: string): ServiceState {
  return {
    service,
    killSwitch: false,
    activeRelease: "current",
    previousRelease: null,
    updatedAt: at,
  };
}

/** The state this operation means to leave behind, or why it cannot be carried out at all. */
function apply(
  operation: ServiceStateOperation,
  before: ServiceState,
  values: Readonly<Record<string, ParameterValue>>,
  at: string,
): ServiceState | string {
  switch (operation) {
    case "kill_switch_on":
      return { ...before, killSwitch: true, updatedAt: at };
    case "kill_switch_off":
      return { ...before, killSwitch: false, updatedAt: at };
    case "rollback": {
      const named = values["release"];
      const target =
        typeof named === "string" && named !== ""
          ? named
          : before.previousRelease;
      if (target === null) {
        return `no previous release is recorded for ${before.service}, so there is nothing to roll back to`;
      }
      if (target === before.activeRelease) {
        return `${before.service} is already running ${target}`;
      }
      return {
        ...before,
        activeRelease: target,
        previousRelease: before.activeRelease,
        updatedAt: at,
      };
    }
  }
}

function describe(
  operation: ServiceStateOperation,
  before: ServiceState,
  after: ServiceState,
): string {
  if (operation === "rollback") {
    return `${before.service} moved from ${before.activeRelease} to ${after.activeRelease}`;
  }
  return `kill switch ${after.killSwitch ? "on" : "off"} for ${before.service}`;
}
