import { type ReactNode } from "react";
import {
  type DemoControl,
  type DemoHealth,
  type DemoView,
  type SessionView,
  labelForState,
  sinceWords,
  toneForState,
} from "../../domain/view.js";
import { get, post } from "../api.js";
import { Waiting, Wrong } from "../parts/states.js";
import { Verdict } from "../parts/verdict.js";
import { BOARD_INTERVAL_MS, usePoll, useServerClock } from "../poll.js";
import { useSaving } from "../save.js";

const TONE: Record<DemoHealth, string> = {
  serving: "tone-green",
  failing: "tone-live",
  off: "tone-amber",
};

const WORD: Record<DemoHealth, string> = {
  serving: "SERVING",
  failing: "FAILING",
  off: "SWITCHED OFF",
};

/**
 * The one service in the estate that is Ringbolt's own, and the only screen in the product with a
 * control that breaks something.
 *
 * It polls on the same interval the deck does, because the whole point is to watch the health flip
 * back without touching anything: break it here, and a minute later the release has been rolled
 * back by an action somebody authorized on a call.
 */
export function Demo({
  go,
  session,
}: {
  go: (path: string) => void;
  session: SessionView;
}): ReactNode {
  const demo = usePoll<DemoView>(
    () => get<DemoView>("/api/demo"),
    BOARD_INTERVAL_MS,
  );
  const now = useServerClock(demo.status === "ready" ? demo.value.now : null);

  if (demo.status === "loading") return <Waiting what="the demo service" />;
  if (demo.status === "failed")
    return <Wrong error={demo.error} again={demo.again} />;

  const view = demo.value;
  return (
    <>
      <header>
        <h1>Demo</h1>
        <p>
          A service Ringbolt owns, so it can be broken on purpose. Everything
          that happens after you break it is the product: the same routing, the
          same call, the same authorization gate, and the same runbook action
          that would run against anybody else&apos;s system.
        </p>
      </header>

      {/* Two columns rather than a grid of equal cards: the service and its
          control are the path a visitor is here to walk, and everything on the
          right is a consequence of walking it. */}
      <div className="detail even">
        <div>
          <section className="card">
            <h2>THE DEMO SERVICE</h2>
            <Readout view={view} now={now} />
          </section>

          <section className="card">
            <h2>BREAK IT</h2>
            {session.calleMode === "live" && <Wired />}
            <Controls view={view} onChanged={demo.again} />
          </section>
        </div>

        <div>
          {view.incident !== null && (
            <section className="card">
              <h2>WHAT RINGBOLT IS DOING ABOUT IT</h2>
              <Working view={view} go={go} />
            </section>
          )}

          {view.publicDemo && (
            <section className="card">
              <h2>WHAT CANNOT HAPPEN HERE</h2>
              <Refusals />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Readout({ view, now }: { view: DemoView; now: number }): ReactNode {
  return (
    <>
      {/* Announced when it changes, because the change is the thing being
          demonstrated and it happens while nobody is touching the page. */}
      <p className={`demo-state ${TONE[view.health]}`} role="status">
        {view.service} is <b>{WORD[view.health]}</b>
      </p>
      <p>{describe(view)}</p>
      <dl className="pairs">
        <dt>Release</dt>
        <dd className="mono">{view.activeRelease}</dd>
        <dt>Previous</dt>
        <dd className="mono">{view.previousRelease ?? "none recorded"}</dd>
        <dt>Kill switch</dt>
        <dd>{view.killSwitch ? "on" : "off"}</dd>
        <dt>Changed</dt>
        <dd>{sinceWords(view.changedAt, now) ?? "never"}</dd>
      </dl>
    </>
  );
}

function describe(view: DemoView): string {
  if (view.health === "failing") {
    return `It is returning ${view.errorPercent} percent errors against a baseline of ${view.baselinePercent}, and it has been since ${view.faultyRelease} went out.`;
  }
  if (view.health === "off") {
    return "Its kill switch is on, so it is serving nothing at all. That is what the other action Ringbolt can be authorized to take does.";
  }
  return `It is returning ${view.errorPercent} percent errors, which is its baseline.`;
}

function Controls({
  view,
  onChanged,
}: {
  view: DemoView;
  onChanged: () => void;
}): ReactNode {
  const saving = useSaving();

  const press = (path: string) => {
    void saving.run(() => post(path, {})).then((ok) => ok && onChanged());
  };

  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>
        Breaking it puts a bad release out and tells Ringbolt, the same way a
        monitor would. Ringbolt decides whether that is worth a call, telephones
        whoever is on the rota, and carries out whatever they authorize.
      </p>
      <div className="row">
        {/* The loud treatment marks the one thing this screen is for, so it
            comes off the control while that control cannot be pressed. A red
            button that does nothing reads as a broken page. */}
        <button
          type="button"
          className={view.controls.breakIt.available ? "btn primary" : "btn"}
          disabled={saving.busy || !view.controls.breakIt.available}
          onClick={() => press("/api/demo/break")}
        >
          Break {view.service}
        </button>
        <button
          type="button"
          className="btn"
          disabled={saving.busy || !view.controls.repair.available}
          onClick={() => press("/api/demo/repair")}
        >
          Put it back by hand
        </button>
      </div>
      <Refused control={view.controls.breakIt} />
      <Refused control={view.controls.repair} />
      <p className="note">
        Putting it back by hand is you reaching into the demo service, not
        Ringbolt acting on it. It is there so the demo can be run again after a
        call that ended in a refusal.
      </p>
      {view.controls.seed.available && (
        <p>
          <button
            type="button"
            className="btn"
            disabled={saving.busy}
            onClick={() => press("/api/demo/seed")}
          >
            Load the example history
          </button>
        </p>
      )}
      <Verdict saving={saving} done="Done." />
    </>
  );
}

/**
 * The server's own reason a control is not available. It is shown rather than swallowed because a
 * disabled button with no explanation reads as a broken page, and the reason is usually the product
 * explaining one of its own rules.
 */
function Refused({ control }: { control: DemoControl }): ReactNode {
  if (control.available || control.why === null) return null;
  return <p className="note tone-amber">{control.why}</p>;
}

function Working({
  view,
  go,
}: {
  view: DemoView;
  go: (path: string) => void;
}): ReactNode {
  const incident = view.incident;
  if (incident === null) return null;

  return (
    <>
      <dl className="pairs">
        <dt>Incident</dt>
        <dd className="mono">{incident.id}</dd>
        <dt>State</dt>
        <dd className={`tone-${toneForState(incident.state)}`}>
          {labelForState(incident.state)}
        </dd>
        <dt>Calls placed</dt>
        <dd className="mono">{incident.callAttempts}</dd>
      </dl>
      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="btn primary" onClick={() => go("/")}>
          Watch it on the deck
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => go(`/incidents/${incident.id}`)}
        >
          Open the record
        </button>
      </div>
    </>
  );
}

/**
 * On a deployment wired to a telephone, this control is not a demonstration. It is a real call to
 * whoever is at the top of the rota, and it is billed whether or not they answer.
 */
function Wired(): ReactNode {
  return (
    <p className="tone-live" role="status" style={{ margin: "0 0 0.75rem" }}>
      This deployment is wired to a real telephone. Breaking the demo service
      here rings whoever is on the rota and costs five cents.
    </p>
  );
}

/** The four things a stranger is owed an answer about before they press anything. */
function Refusals(): ReactNode {
  return (
    <ul className="plain">
      <li>
        No telephone rings. This deployment refuses to start in live mode at
        all, so the call you are about to watch is the local stand-in.
      </li>
      <li>
        Nothing outside this deployment is touched. Every runbook action here is
        refused a host to call, so the only thing an action can change is state
        Ringbolt owns.
      </li>
      <li>
        Nothing can be configured. Every write is refused apart from the two
        controls above, whatever anybody sends.
      </li>
      <li>
        Telephone numbers are withheld. Names stay, because a name is who
        authorized a production change and that is the record.
      </li>
    </ul>
  );
}
