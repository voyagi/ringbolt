import { type ReactNode, useState } from "react";
import {
  type ActionDefinitionView,
  type ServicePolicyView,
  isSeverity,
  severities,
} from "../../domain/view.js";
import { get, put, remove } from "../api.js";
import { AreaField, CheckList, PickField, TextField } from "../parts/fields.js";
import { Nothing, Waiting, Wrong } from "../parts/states.js";
import { Verdict } from "../parts/verdict.js";
import { usePoll } from "../poll.js";
import { useSaving } from "../save.js";

type Catalogue = {
  actions: ActionDefinitionView[];
  allowedHosts: string[] | null;
};

/**
 * What Ringbolt may be asked to do, and which services may ask. Both halves live on one screen
 * because a policy is mostly a choice of which of these actions a service is allowed to offer, and
 * choosing from a list you cannot see is how a service ends up offering nothing.
 */
export function Runbooks(): ReactNode {
  const actions = usePoll<Catalogue>(() => get("/api/config/actions"), null);
  const services = usePoll<{ services: ServicePolicyView[] }>(
    () => get("/api/config/services"),
    null,
  );

  if (actions.status === "loading" || services.status === "loading")
    return <Waiting what="the runbook" />;
  if (actions.status === "failed")
    return <Wrong error={actions.error} again={actions.again} />;
  if (services.status === "failed")
    return <Wrong error={services.error} again={services.again} />;

  return (
    <>
      <header>
        <h1>Runbooks</h1>
        <p>
          An action is a row, not code. Everything that can be refused about one
          is refused here at a keyboard rather than at three in the morning: the
          shape, the phrase somebody has to say out loud, and the hosts this
          deployment is allowed to reach.
        </p>
      </header>

      <p className="note" style={{ marginBottom: "1.25rem" }}>
        {actions.value.allowedHosts === null
          ? "This deployment is in development, so an action may call any host the url rule accepts."
          : actions.value.allowedHosts.length === 0
            ? "ACTION_HOST_ALLOWLIST names no host, so no action may reach outside Ringbolt itself."
            : `An action may only call: ${actions.value.allowedHosts.join(", ")}.`}
      </p>

      <div className="forms">
        {actions.value.actions.map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            onChanged={actions.again}
          />
        ))}
      </div>

      <h2 style={{ margin: "2rem 0 0.25rem" }}>Services</h2>
      <p className="note" style={{ marginBottom: "1.25rem" }}>
        A service with no policy of its own calls about everything and may offer
        every action, so nothing has to be set up before Ringbolt works.
      </p>

      {services.value.services.length === 0 ? (
        <Nothing heading="No service has a policy yet">
          Every service is on the defaults. A policy appears here once one is
          written for it.
        </Nothing>
      ) : (
        <div className="forms">
          {services.value.services.map((policy) => (
            <PolicyCard
              key={policy.service}
              policy={policy}
              actions={actions.value.actions}
              onChanged={services.again}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ActionCard({
  action,
  onChanged,
}: {
  action: ActionDefinitionView;
  onChanged: () => void;
}): ReactNode {
  const [label, setLabel] = useState(action.label);
  const [spoken, setSpoken] = useState(action.spokenDescription);
  const [phrase, setPhrase] = useState(action.confirmationPhrase ?? "");
  const [floor, setFloor] = useState(
    action.minConfidence === null ? "" : String(action.minConfidence),
  );
  const [target, setTarget] = useState(pretty(action.target));
  const [parameters, setParameters] = useState(pretty(action.parameters));
  const [verify, setVerify] = useState(pretty(action.verify));
  const saving = useSaving();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = {
      label,
      spokenDescription: spoken,
      confirmationPhrase: phrase.trim() === "" ? null : phrase,
      minConfidence: floor.trim() === "" ? null : Number(floor),
      parameters: loose(parameters),
      target: loose(target),
      verify: loose(verify),
    };
    if (await saving.run(() => put(`/api/config/actions/${action.id}`, body)))
      onChanged();
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>{action.id}</h2>
      <TextField label="LABEL" value={label} onChange={setLabel} />
      <AreaField
        label="READ OUT ON THE CALL"
        hint="A sentence the responder hears, not a description of a function."
        rows={3}
        value={spoken}
        onChange={setSpoken}
      />
      <TextField
        label="CONFIRMATION PHRASE"
        hint="The exact words that have to be said back. Empty means this one is not destructive."
        value={phrase}
        onChange={setPhrase}
      />
      <TextField
        label="MINIMUM CONFIDENCE"
        hint="Above the product-wide floor of 0.7. Empty leaves it at the floor."
        value={floor}
        onChange={setFloor}
      />
      <AreaField
        label="PARAMETERS"
        value={parameters}
        onChange={setParameters}
      />
      <AreaField label="TARGET" value={target} onChange={setTarget} />
      <AreaField
        label="CHECK AFTERWARDS"
        hint="A read of the system that was changed. null means nothing is checked, and a run then records itself as unverified."
        value={verify}
        onChange={setVerify}
      />
      <div className="row">
        <button className="btn primary" type="submit" disabled={saving.busy}>
          Save this action
        </button>
        <button
          className="btn quiet"
          type="button"
          disabled={saving.busy}
          onClick={() => {
            void saving
              .run(() => remove(`/api/config/actions/${action.id}`))
              .then((ok) => ok && onChanged());
          }}
        >
          Delete
        </button>
        <Verdict saving={saving} done="Saved." />
      </div>
    </form>
  );
}

function PolicyCard({
  policy,
  actions,
  onChanged,
}: {
  policy: ServicePolicyView;
  actions: readonly ActionDefinitionView[];
  onChanged: () => void;
}): ReactNode {
  const [minSeverity, setMinSeverity] = useState(policy.minSeverity);
  const [allowed, setAllowed] = useState<string[]>(policy.allowedActions);
  const [flap, setFlap] = useState(String(policy.flapWindowMinutes));
  const [maxCalls, setMaxCalls] = useState(String(policy.maxCallsPerWindow));
  const [escalate, setEscalate] = useState(String(policy.escalateAfterMinutes));
  const saving = useSaving();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = {
      minSeverity,
      quietHours: policy.quietHours,
      allowedActions: allowed,
      flapWindowMinutes: Number(flap),
      maxCallsPerWindow: Number(maxCalls),
      escalateAfterMinutes: Number(escalate),
    };
    if (
      await saving.run(() =>
        put(`/api/config/services/${encodeURIComponent(policy.service)}`, body),
      )
    )
      onChanged();
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>{policy.service}</h2>
      <PickField
        label="CALL ABOUT THIS AND WORSE"
        value={minSeverity}
        onChange={(next) => isSeverity(next) && setMinSeverity(next)}
        options={severities.map((one) => ({ value: one, label: one }))}
      />
      <CheckList
        legend="ACTIONS THIS SERVICE MAY OFFER"
        hint="Only these are read out on a call, and only these can be authorized."
        options={actions.map((one) => ({ value: one.id, label: one.label }))}
        chosen={allowed}
        onChange={setAllowed}
      />
      <TextField
        label="SUPPRESSION WINDOW, MINUTES"
        hint="One broken thing is one phone call. Repeats inside this window do not ring."
        value={flap}
        onChange={setFlap}
      />
      <TextField
        label="CALLS ALLOWED IN THAT WINDOW"
        value={maxCalls}
        onChange={setMaxCalls}
      />
      <TextField
        label="ESCALATE AFTER, MINUTES"
        hint="How long a call may run before the next person in the rota is tried."
        value={escalate}
        onChange={setEscalate}
      />
      <div className="row">
        <button className="btn primary" type="submit" disabled={saving.busy}>
          Save this policy
        </button>
        <Verdict saving={saving} done="Saved." />
      </div>
    </form>
  );
}

function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/**
 * Text an operator typed, handed to the server as it is when it does not parse. The server owns
 * every rule about these shapes and explains what it refused; a browser-side parse error here would
 * be a second, worse explanation of the same problem.
 */
function loose(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
