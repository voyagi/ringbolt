import type { OfferedAction } from "../domain/incident.js";
import type { ActionContext, ActionResult } from "./context.js";
import type {
  ActionDefinition,
  ActionParameter,
  ParameterValue,
} from "./definition.js";
import { runHttp } from "./http.js";
import { runServiceState } from "./service-state.js";

export type { ActionContext, ActionResult } from "./context.js";

/**
 * A definition compiled into something that can be offered on a call and then carried out. It
 * carries its own guardrails rather than pointing at them, so the object the authorization gate
 * decides about is the object that runs.
 */
export type RunbookAction = OfferedAction & {
  parameters: readonly ActionParameter[];
  minConfidence: number | null;
  run: (
    values: Readonly<Record<string, ParameterValue>>,
    context: ActionContext,
  ) => Promise<ActionResult>;
};

/**
 * The only way into the action list, and it takes the ids a service's policy permits rather than
 * the service name. The authorization gate runs the action objects this returns rather than looking
 * an id up in a list again, so narrowing the permitted set here narrows what can actually run.
 */
export function actionsAllowedBy(
  definitions: readonly ActionDefinition[],
  allowed: readonly string[],
): readonly RunbookAction[] {
  const permitted = new Set(allowed);
  return definitions
    .filter((definition) => permitted.has(definition.id))
    .map(compileAction);
}

export function compileAction(definition: ActionDefinition): RunbookAction {
  const target = definition.target;
  return {
    id: definition.id,
    label: definition.label,
    spokenDescription: definition.spokenDescription,
    confirmationPhrase: definition.confirmationPhrase,
    parameters: definition.parameters,
    minConfidence: definition.minConfidence,
    run: (values, context) =>
      target.kind === "service_state"
        ? runServiceState(target.operation, values, context)
        : runHttp(target, definition.verify, values, context),
  };
}

/** The spoken half of an action, which is what a call is allowed to know about it. */
export function offeredFrom(definition: ActionDefinition): OfferedAction {
  return {
    id: definition.id,
    label: definition.label,
    spokenDescription: definition.spokenDescription,
    confirmationPhrase: definition.confirmationPhrase,
  };
}
