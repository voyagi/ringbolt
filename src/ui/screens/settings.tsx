import type { ReactNode } from "react";
import type { BudgetView, SessionView } from "../../domain/view.js";
import { get, rememberToken } from "../api.js";
import { Waiting, Wrong } from "../parts/states.js";
import { usePoll } from "../poll.js";

/**
 * The connection, what it has cost, and how to send Ringbolt an alert.
 *
 * Nothing here is editable, and that is deliberate rather than unfinished. The telephone
 * credential, the numbers a live build may ring and the hosts an action may reach are deployment
 * configuration, so the only way to change one is a deploy. A screen that let somebody type a new
 * API key into a database would be a screen that let somebody type a new API key into a database.
 */
export function Settings({
  session,
  onSignOut,
}: {
  session: SessionView;
  onSignOut: () => void;
}): ReactNode {
  const budget = usePoll<BudgetView>(() => get("/api/budget"), null);
  const origin = window.location.origin;

  return (
    <>
      <header>
        <h1>Settings</h1>
        <p>
          What this deployment is wired to. Every value on this page is set at
          deploy time, so changing one is a deploy rather than a form.
        </p>
      </header>

      <div className="forms">
        <section className="card">
          <h2>THE TELEPHONE</h2>
          <dl className="pairs">
            <dt>Mode</dt>
            <dd
              className={
                session.calleMode === "live" ? "tone-live" : "tone-cyan"
              }
            >
              {session.calleMode === "live"
                ? "live, so a call reaches a real telephone"
                : "the local stand-in, so no call can reach anybody"}
            </dd>
            <dt>Environment</dt>
            <dd>{session.environment}</dd>
            <dt>Administration</dt>
            <dd>
              {session.admin === "open"
                ? "open, because this is a development build talking to itself"
                : "a token is required"}
            </dd>
          </dl>
          {session.admin === "token" && (
            <p style={{ marginTop: "1rem" }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  rememberToken(null);
                  onSignOut();
                }}
              >
                Forget this token
              </button>
            </p>
          )}
        </section>

        <section className="card">
          <h2>WHAT REAL CALLS HAVE COST</h2>
          {budget.status === "loading" && <Waiting what="the ledger" />}
          {budget.status === "failed" && <Wrong error={budget.error} />}
          {budget.status === "ready" && <Spend budget={budget.value} />}
          <p className="note">
            CALL-E bills per call task created, connected or not. The ceiling is
            CALLE_CREDIT_USD and it defaults to nothing, so a live build cannot
            spend a cent until somebody writes down what they are prepared to
            lose.
          </p>
        </section>

        <section className="card">
          <h2>SENDING RINGBOLT AN ALERT</h2>
          <p className="note" style={{ marginTop: 0 }}>
            Any monitor that can make an HTTP request can open an incident. The
            token in the path is INTAKE_TOKEN.
          </p>
          {/* Scrolls sideways on a narrow screen, so it has to be reachable by
              keyboard, and the role has to sit on the SAME element: the pre is
              what scrolls, and a pre carries no role of its own, so an
              aria-label on a bare one is not reliably announced. */}
          <pre
            className="raw"
            role="region"
            tabIndex={0}
            aria-label="An example intake request"
          >{`curl -X POST ${origin}/intake/YOUR_INTAKE_TOKEN \\
  -H 'content-type: application/json' \\
  -d '{
    "service": "checkout",
    "title": "Payment errors above 20 percent",
    "severity": "critical",
    "detail": "Error rate 23.1 percent against a 0.2 percent baseline.",
    "source": "prometheus"
  }'`}</pre>
        </section>

        <section className="card">
          <h2>WHAT IS KEPT</h2>
          <p className="note" style={{ marginTop: 0 }}>
            Ringbolt stores the incident, the transcript of every call it placed
            about it, the decision that came back and what ran. A transcript and
            a telephone number are personal data. Both sit behind the
            administration token today, and a retention window that deletes them
            on a schedule is phase 7 rather than something this build already
            does.
          </p>
        </section>
      </div>
    </>
  );
}

function Spend({ budget }: { budget: BudgetView }): ReactNode {
  return (
    <dl className="pairs">
      <dt>Real calls placed</dt>
      <dd className="mono">{budget.realCallsPlaced}</dd>
      <dt>Spent</dt>
      <dd className="mono">
        ${budget.spentUsd.toFixed(2)} at ${budget.callPriceUsd.toFixed(2)} each
      </dd>
      <dt>Credit</dt>
      <dd className="mono">
        {budget.creditUsd === 0
          ? "none set, so no live call can be placed"
          : `$${budget.creditUsd.toFixed(2)}`}
      </dd>
      <dt>Left</dt>
      <dd className="mono">
        ${budget.remainingUsd.toFixed(2)}, {budget.callsRemaining} calls
      </dd>
    </dl>
  );
}
