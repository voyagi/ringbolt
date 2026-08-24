import type { ReactNode } from "react";
import {
  type ActionRunView,
  type CallView,
  type EventView,
  type IncidentView,
  labelForState,
  sinceWords,
  toneForState,
  verifiedFlag,
} from "../../domain/view.js";
import { get } from "../api.js";
import { usePoll } from "../poll.js";
import {
  Docket,
  TalkTrack,
  Transcript,
  grantingTurn,
  runsByCall,
  spokenPhrase,
} from "../parts/call.js";
import { Waiting, Wrong } from "../parts/states.js";

type Record = {
  incident: IncidentView;
  events: EventView[];
  calls: (CallView | null)[];
  actions: ActionRunView[];
};

/**
 * One incident in full: the timeline, what was said on every call it took, the decision that came
 * back, what ran, and the system state either side of it. It is the page somebody opens the morning
 * after to work out whether Ringbolt did the right thing.
 */
export function Incident({ id }: { id: string }): ReactNode {
  const loaded = usePoll<Record>(
    () => get(`/api/audit/incidents/${encodeURIComponent(id)}`),
    null,
  );

  if (loaded.status === "loading") return <Waiting what="the record" />;
  if (loaded.status === "failed")
    return <Wrong error={loaded.error} again={loaded.again} />;

  const { incident, events, actions } = loaded.value;
  const calls = loaded.value.calls.filter(
    (call): call is CallView => call !== null,
  );
  const now = Date.now();

  return (
    <>
      <header>
        <p className={`label tone-${toneForState(incident.state)}`}>
          {labelForState(incident.state)}
        </p>
        <h1>
          {incident.service}: {incident.title}
        </h1>
        <p>
          {incident.severity}, opened {sinceWords(incident.createdAt, now)}
          {incident.source === null ? "" : ` by ${incident.source}`}.
        </p>
      </header>

      <div className="detail">
        <div>
          {calls.length === 0 ? (
            <section className="card">
              <h2>THE CALLS</h2>
              <p className="heard">
                No call has been recorded against this incident yet.
              </p>
            </section>
          ) : (
            calls.map((call, index) => (
              <Call
                key={call.recordedAt}
                call={call}
                run={runsByCall(calls, actions)[index]?.[0]}
                index={index}
                total={calls.length}
              />
            ))
          )}

          {actions.map((run) => (
            <Run key={run.id} run={run} />
          ))}
        </div>

        <div>
          <section className="card">
            <h2>THE INCIDENT</h2>
            <dl className="pairs">
              <Pair label="Detail">{incident.detail ?? "none sent"}</Pair>
              <Pair label="Started">
                {incident.startedAt === null
                  ? "the monitor did not say"
                  : (sinceWords(incident.startedAt, now) ?? "unknown")}
              </Pair>
              <Pair label="Calls placed">{String(incident.callAttempts)}</Pair>
              <Pair label="Last called">
                {incident.contactName ?? "nobody"}
              </Pair>
              <Pair label="Offered">
                {incident.offeredActions.length === 0
                  ? "nothing was on the table"
                  : incident.offeredActions.join(", ")}
              </Pair>
              <Pair label="Outcome">{incident.outcome ?? "still running"}</Pair>
            </dl>
            {incident.links.length > 0 && (
              <p className="note">
                {incident.links.map((link) => (
                  <a key={link.url} href={link.url} rel="noreferrer noopener">
                    {link.label}{" "}
                  </a>
                ))}
              </p>
            )}
          </section>

          <section className="card">
            <h2>TIMELINE</h2>
            <ol className="ledger">
              {events.map((event) => (
                <li key={event.id}>
                  <span className="at mono">{stamp(event.at)}</span>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}

function Call({
  call,
  run,
  index,
  total,
}: {
  call: CallView;
  run: ActionRunView | undefined;
  index: number;
  total: number;
}): ReactNode {
  const grant = grantingTurn(call.transcript, spokenPhrase(run));
  return (
    <section className="card">
      <h2>
        {total === 1 ? "THE CALL" : `CALL ${index + 1} OF ${total}`} &middot;{" "}
        {call.status}
        {call.confidence === null
          ? ""
          : ` · confidence ${call.confidence.toFixed(2)}`}
      </h2>
      <TalkTrack transcript={call.transcript} grant={grant} />
      <Transcript call={call} grant={grant} />
      {run !== undefined && <Docket run={run} confidence={call.confidence} />}
      {call.summary !== null && <p className="heard">{call.summary}</p>}
    </section>
  );
}

/** What actually happened to the system, with the state either side of it kept whole. */
function Run({ run }: { run: ActionRunView }): ReactNode {
  const verified = verifiedFlag(run.verification);
  return (
    <section className="card">
      <h2>WHAT RAN: {run.actionId}</h2>
      <dl className="pairs">
        <Pair label="Authorized by">{run.authorizedBy ?? "not recorded"}</Pair>
        <Pair label="Outcome">{run.outcome}</Pair>
        <Pair label="Checked afterwards">
          {verified === null
            ? "nobody looked, so this is recorded as unverified"
            : verified
              ? "confirmed against the system itself"
              : "the check did not find what it expected"}
        </Pair>
        <Pair label="Detail">{run.detail ?? "none"}</Pair>
      </dl>
      <p className="label" style={{ margin: "1rem 0 0.5rem" }}>
        THE SYSTEM BEFORE, AND AFTER
      </p>
      <pre
        className="raw"
        role="region"
        tabIndex={0}
        aria-label="The system state before and after this action"
      >{`before  ${json(run.stateBefore)}
after   ${json(run.stateAfter)}`}</pre>
    </section>
  );
}

function Pair({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Twenty four hour, for the reason given on the deck's own clock. */
function stamp(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return "--:--:--";
  return parsed.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
