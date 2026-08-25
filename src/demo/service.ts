import type { Repo, ServiceState } from "../db/repo.js";
import type { AlertPayload, Incident } from "../domain/incident.js";
import { defaultPolicy } from "../domain/policy.js";
import type {
  DemoControl,
  DemoHealth,
  DemoView,
  IncidentState,
} from "../domain/view.js";
import { openIncidentStates, scheduledStates } from "../domain/view.js";

/**
 * The one service Ringbolt is allowed to break on purpose.
 *
 * Every other service in the product is somebody else's: alerts arrive about it and Ringbolt acts
 * on it, but it never decides how it is doing. This one is the exception the roadmap asks for, and
 * the exception is bounded by where its health comes from: `service_state`, the same table a
 * runbook action writes. So breaking it is a row, fixing it is a row, and the fix is the same
 * `rollback` action a responder authorizes on a real incident rather than a demo-only shortcut.
 */
export const DEMO_SERVICE = "dockside";

/** The release the demo service runs when it is well, and the one that breaks it. */
export const HEALTHY_RELEASE = "2026.08.25-a";
export const FAULTY_RELEASE = "2026.08.25-b";

/**
 * Fixed, so every break of the demo service is the same problem. Repeats collapse into the open
 * incident exactly as a monitor's repeats would, which is what makes a stranger pressing the button
 * four times one phone call rather than four.
 */
export const DEMO_FINGERPRINT = "demo:dockside:payment-errors";

/**
 * What the demo service reports about itself. These are the fiction's own numbers rather than a
 * measurement of anything: the service is a story about a checkout, and the story is that the bad
 * release takes payment errors from a fifth of a percent to twenty three. They are here rather than
 * written into a screen so the alert Ringbolt receives and the page a visitor reads cannot disagree.
 */
export const BASELINE_ERROR_PERCENT = 0.2;
export const FAULTY_ERROR_PERCENT = 23.4;

/**
 * States an incident is in while Ringbolt is actually doing something about it, as opposed to
 * deliberately waiting. Derived rather than listed: an open state that is not parked with a time on
 * it is one where a call or an action is in flight, and the repair control is refused during
 * exactly those.
 */
const ACTIVE_STATES: readonly IncidentState[] = openIncidentStates.filter(
  (state) => !(scheduledStates as readonly IncidentState[]).includes(state),
);

export function healthOf(state: ServiceState | null): DemoHealth {
  if (state === null) return "serving";
  if (state.killSwitch) return "off";
  return state.activeRelease === FAULTY_RELEASE ? "failing" : "serving";
}

function errorPercentFor(health: DemoHealth): number {
  if (health === "failing") return FAULTY_ERROR_PERCENT;
  // A service that has been switched off is not serving errors. It is not serving anything, which
  // is the whole point of the kill switch and the reason this is not just "healthy or not".
  return health === "off" ? 0 : BASELINE_ERROR_PERCENT;
}

function initialState(at: string): ServiceState {
  return {
    service: DEMO_SERVICE,
    killSwitch: false,
    activeRelease: HEALTHY_RELEASE,
    previousRelease: null,
    updatedAt: at,
  };
}

/**
 * The alert the demo service's own watch sends when it goes bad. It goes in through the same
 * orchestrator every other alert does, so the demo exercises the product rather than a path built
 * for it. The one thing it does not go through is the HTTP intake, because that needs the intake
 * token and this control is meant to work for a stranger with no credentials at all.
 */
export function demoAlert(state: ServiceState): AlertPayload {
  return {
    service: DEMO_SERVICE,
    title: "Payment errors above 20 percent",
    severity: "critical",
    detail: `Error rate ${FAULTY_ERROR_PERCENT} percent against a ${BASELINE_ERROR_PERCENT} percent baseline, since ${state.activeRelease} went out.`,
    fingerprint: DEMO_FINGERPRINT,
    source: "the demo service's own watch",
    startedAt: state.updatedAt,
    links: [],
  };
}

/**
 * Makes sure the demo service exists before anybody leans on it: a state row to read health from,
 * and a policy of its own.
 *
 * The policy is the reason this is not left to the defaults. A service with no policy gets one call
 * per fifteen minutes, which is the right answer for a real estate and the wrong one for something
 * a visitor is invited to press twice: the second demo would be suppressed and read as broken. A
 * short window with a few calls in it keeps the suppression rule real and still lets the loop be
 * shown again a minute later.
 *
 * Neither write overwrites anything. An operator who edits the demo policy keeps their edit.
 */
export async function ensureDemoService(
  repo: Repo,
  now: Date,
): Promise<ServiceState> {
  const at = now.toISOString();
  const existing = await repo.getServiceState(DEMO_SERVICE);
  const state = existing ?? initialState(at);
  if (existing === null) await repo.upsertServiceState(state);

  if ((await repo.getServicePolicy(DEMO_SERVICE)) === null) {
    const defined = await repo.listActionDefinitions();
    await repo.upsertServicePolicy({
      ...defaultPolicy(
        DEMO_SERVICE,
        defined.map((definition) => definition.id),
        at,
      ),
      flapWindowMinutes: 2,
      maxCallsPerWindow: 3,
      escalateAfterMinutes: 2,
    });
  }

  return state;
}

export type DemoChange =
  { ok: true; state: ServiceState } | { ok: false; why: string };

/**
 * Puts the bad release out. It records the release it replaced, which is what gives the rollback
 * somewhere to go back to, and it clears the kill switch: a service that is switched off is not
 * serving the errors this is supposed to be about.
 */
export async function breakDemoService(
  repo: Repo,
  now: Date,
): Promise<DemoChange> {
  const before = await ensureDemoService(repo, now);
  const refusal = whyNotBreak(healthOf(before));
  if (refusal !== null) return { ok: false, why: refusal };

  const state: ServiceState = {
    ...before,
    killSwitch: false,
    activeRelease: FAULTY_RELEASE,
    previousRelease: before.activeRelease,
    updatedAt: now.toISOString(),
  };
  await repo.upsertServiceState(state);
  return { ok: true, state };
}

/**
 * Puts the demo service back by hand. This is the operator reaching into the demo service, not
 * Ringbolt acting on it, and the screen says so: the whole point of the demo is that the rollback
 * is authorized on a call.
 */
export async function repairDemoService(
  repo: Repo,
  now: Date,
): Promise<DemoChange> {
  const before = await ensureDemoService(repo, now);
  const refusal = whyNotRepair(healthOf(before), await openDemoIncident(repo));
  if (refusal !== null) return { ok: false, why: refusal };

  const state: ServiceState = {
    ...before,
    killSwitch: false,
    activeRelease: HEALTHY_RELEASE,
    previousRelease: before.activeRelease,
    updatedAt: now.toISOString(),
  };
  await repo.upsertServiceState(state);
  return { ok: true, state };
}

export function openDemoIncident(repo: Repo): Promise<Incident | null> {
  return repo.findOpenByFingerprint(DEMO_FINGERPRINT);
}

function whyNotBreak(health: DemoHealth): string | null {
  if (health === "failing")
    return `${DEMO_SERVICE} is already failing, so there is nothing left to break.`;
  if (health === "off")
    return `${DEMO_SERVICE} is switched off, so it is not serving anything to break. Put it back first.`;
  return null;
}

function whyNotRepair(
  health: DemoHealth,
  incident: Incident | null,
): string | null {
  if (health === "serving")
    return `${DEMO_SERVICE} is already serving ${HEALTHY_RELEASE}.`;
  if (incident !== null && ACTIVE_STATES.includes(incident.state)) {
    return `Ringbolt is dealing with this one: ${incident.id} is ${incident.state}. Putting the service back underneath a call in flight would leave the record saying something that did not happen.`;
  }
  return null;
}

/**
 * Everything the demo screen draws, decided here rather than in the browser. Each control carries
 * whether it may be pressed and why not, and the endpoints refuse on the same two functions, so a
 * button that looks available and a request that is refused cannot disagree.
 */
export async function readDemo(
  repo: Repo,
  now: Date,
  options: { publicDemo: boolean; seeded: boolean },
): Promise<DemoView> {
  const state = (await repo.getServiceState(DEMO_SERVICE)) ?? initialState("");
  const health = healthOf(state);
  const incident = await openDemoIncident(repo);

  return {
    service: DEMO_SERVICE,
    health,
    activeRelease: state.activeRelease,
    previousRelease: state.previousRelease,
    killSwitch: state.killSwitch,
    errorPercent: errorPercentFor(health),
    baselinePercent: BASELINE_ERROR_PERCENT,
    faultyRelease: FAULTY_RELEASE,
    healthyRelease: HEALTHY_RELEASE,
    changedAt: state.updatedAt === "" ? null : state.updatedAt,
    now: now.toISOString(),
    incident:
      incident === null
        ? null
        : {
            id: incident.id,
            state: incident.state,
            wakeAt: incident.wakeAt,
            callAttempts: incident.callAttempts,
          },
    controls: {
      breakIt: control(whyNotBreak(health)),
      repair: control(whyNotRepair(health, incident)),
      seed: control(
        options.seeded ? "The example history is already loaded." : null,
      ),
    },
    publicDemo: options.publicDemo,
  };
}

function control(why: string | null): DemoControl {
  return { available: why === null, why };
}
