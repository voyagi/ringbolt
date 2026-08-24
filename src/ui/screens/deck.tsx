import type { ReactNode } from "react";
import {
  type ArrivalBucket,
  type BoardView,
  type DeckFocus,
  type EventView,
  type IncidentView,
  asClock,
  elapsedFraction,
  labelForState,
  sinceWords,
  toneForSeverity,
  toneForState,
} from "../../domain/view.js";
import { get } from "../api.js";
import { BOARD_INTERVAL_MS, usePoll, useServerClock } from "../poll.js";
import {
  Docket,
  TalkTrack,
  Transcript,
  grantingTurn,
  spokenPhrase,
} from "../parts/call.js";
import { Gauge } from "../parts/gauge.js";
import { Nothing, Stale, Waiting, Wrong } from "../parts/states.js";

export function Deck({ go }: { go: (path: string) => void }): ReactNode {
  const board = usePoll<BoardView>(
    () => get<BoardView>("/api/audit/board"),
    BOARD_INTERVAL_MS,
  );
  const now = useServerClock(board.status === "ready" ? board.value.now : null);

  if (board.status === "loading") return <Waiting what="the deck" />;
  if (board.status === "failed")
    return <Wrong error={board.error} again={board.again} />;

  const view = board.value;
  return (
    <>
      {board.stale !== null && (
        <p className="page" style={{ flex: "none", padding: "0.5rem 1.25rem" }}>
          <Stale error={board.stale} at={board.at} now={Date.now()} />
        </p>
      )}
      <div className="cluster">
        {/* Each column scrolls on its own, so each one is a scrollable region a
            keyboard has to be able to reach. */}
        <section
          className="instrument"
          tabIndex={0}
          aria-label="The incident in focus"
        >
          {view.focus === null ? (
            <Quiet />
          ) : (
            <Instrument
              focus={view.focus}
              rota={view.rota.contacts.length}
              now={now}
            />
          )}
        </section>
        <section tabIndex={0} aria-label="The call">
          {view.focus === null ? (
            <p className="heard">Nothing is on the line.</p>
          ) : (
            <Readout focus={view.focus} />
          )}
        </section>
        <section
          className="standing"
          tabIndex={0}
          aria-label="Standing incidents and the rota"
        >
          <h2 className="label">STANDING</h2>
          {view.standing.length === 0 ? (
            <p className="heard">Nothing else is open.</p>
          ) : (
            view.standing.map((incident) => (
              <Unit
                key={incident.id}
                incident={incident}
                now={now}
                onOpen={() => go(`/incidents/${incident.id}`)}
              />
            ))
          )}
          <Rota
            names={view.rota.contacts.map((one) => one.name)}
            usesConfiguredNumber={view.rota.usesConfiguredNumber}
          />
        </section>
      </div>
      <Strip board={view} />
    </>
  );
}

function Quiet(): ReactNode {
  return (
    <Nothing heading="Nothing is on fire">
      No incident is open. When a monitor posts an alert, this is where it lands
      and the ring starts counting the call.
    </Nothing>
  );
}

function Instrument({
  focus,
  rota,
  now,
}: {
  focus: DeckFocus;
  rota: number;
  now: number;
}): ReactNode {
  const incident = focus.incident;
  const ringing = incident.state === "calling";
  const from = ringing ? incident.callStartedAt : incident.updatedAt;
  const seconds =
    from === null ? null : Math.max(0, (now - Date.parse(from)) / 1000);

  return (
    <>
      <h1 className="service">{incident.service}</h1>
      <p className="why">{incident.title}</p>
      <Gauge
        seconds={seconds}
        outer={elapsedFraction(from, incident.wakeAt, now)}
        inner={rota === 0 ? null : (incident.rotationPosition + 1) / rota}
        tone={`tone-${toneForState(incident.state)}`}
        state={labelForState(incident.state)}
        under={under(incident, rota)}
      />
      <dl className="facts">
        <Fact
          label="SEVERITY"
          tone={`tone-${toneForSeverity(incident.severity)}`}
        >
          {incident.severity}
        </Fact>
        <Fact label="SENT BY">{incident.source ?? "an unnamed monitor"}</Fact>
        <Fact label="STARTED">
          {sinceWords(incident.startedAt ?? incident.createdAt, now) ??
            "unknown"}
        </Fact>
        <Fact label="REPEATS" mono>
          {String(focus.repeats)}
        </Fact>
      </dl>
      <Trace buckets={focus.arrivals} service={incident.service} />
      <Sent incident={incident} />
      <p className="rings">
        <span>
          attempt <b className="mono">{incident.callAttempts}</b>
        </span>
        <span>
          opened <b className="mono">{clockOf(incident.createdAt)}</b>
        </span>
      </p>
    </>
  );
}

function under(incident: IncidentView, rota: number): string {
  if (incident.state === "calling") {
    const who = incident.contactName ?? "the configured number";
    return rota === 0
      ? `ringing ${who}`
      : `ringing ${who}, ${incident.rotationPosition + 1} of ${rota}`;
  }
  if (incident.wakeReason !== null)
    return `waiting: ${incident.wakeReason.replace(/_/g, " ")}`;
  return incident.outcome ?? "on the board";
}

function Fact({
  label,
  tone,
  mono,
  children,
}: {
  label: string;
  tone?: string;
  mono?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className={`${tone ?? ""}${mono === true ? " mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

/**
 * Alerts arriving for this service, in five minute buckets. It is the only time series Ringbolt
 * genuinely holds: the product consumes alerts rather than measuring anything, so a chart of an
 * error rate would be a chart of a number nobody sent it.
 */
function Trace({
  buckets,
  service,
}: {
  buckets: readonly ArrivalBucket[];
  service: string;
}): ReactNode {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.alerts));
  const total = buckets.reduce((sum, bucket) => sum + bucket.alerts, 0);

  return (
    <>
      <div
        className="trace"
        role="img"
        aria-label={`${total} alerts for ${service} in the last 50 minutes, in five minute buckets.`}
      >
        {buckets.map((bucket) => (
          <i
            key={bucket.at}
            className={
              bucket.alerts === 0 ? "none" : bucket.alerts >= peak ? "hot" : ""
            }
            style={{
              height:
                bucket.alerts === 0
                  ? "1px"
                  : `${(bucket.alerts / peak) * 100}%`,
            }}
          />
        ))}
      </div>
      <p className="trace-scale">
        <span>{clockOf(buckets[0]?.at ?? null)}</span>
        <span>ALERTS IN, 5 MIN BUCKETS</span>
        <span>now</span>
      </p>
    </>
  );
}

/**
 * The alert as it arrived, in the sender's own words, plus wherever it points. It is the last thing
 * on the left because it is the raw material: everything above it is Ringbolt's reading of this, and
 * a responder who disagrees with that reading needs the original to hand.
 */
function Sent({ incident }: { incident: IncidentView }): ReactNode {
  if (incident.detail === null && incident.links.length === 0) return null;
  return (
    <div className="sent">
      <h2 className="label">WHAT THE MONITOR SENT</h2>
      {incident.detail !== null && <p>{incident.detail}</p>}
      {incident.links.map((link) => (
        <a key={link.url} href={link.url} rel="noreferrer noopener">
          {link.label}
        </a>
      ))}
    </div>
  );
}

function Readout({ focus }: { focus: DeckFocus }): ReactNode {
  const call = focus.call;
  const run = focus.actions[focus.actions.length - 1];
  const grant =
    call === null ? null : grantingTurn(call.transcript, spokenPhrase(run));

  return (
    <>
      <h2 className="label">THE CALL</h2>
      {call === null ? (
        <p className="heard">
          The line is open. Nothing comes back until the call ends, because a
          call that is still running carries no decision.
        </p>
      ) : (
        <>
          <TalkTrack transcript={call.transcript} grant={grant} />
          <Transcript call={call} grant={grant} />
          {run === undefined ? (
            <Refused events={focus.events} />
          ) : (
            <>
              <Docket run={run} confidence={call.confidence} />
              <p className="heard">
                {run.detail ?? "The action ran."}{" "}
                {run.durationMs !== null && (
                  <>
                    Took <b>{(run.durationMs / 1000).toFixed(1)}s</b> over{" "}
                    <b>{run.attempts}</b> attempt
                    {run.attempts === 1 ? "" : "s"}.
                  </>
                )}
              </p>
            </>
          )}
        </>
      )}
      <Ledger events={focus.events} />
    </>
  );
}

/**
 * A refusal is a normal outcome, not an error, and it is the outcome this product exists to make
 * safe. It gets the same weight on the deck as an action that ran.
 */
function Refused({ events }: { events: readonly EventView[] }): ReactNode {
  const refusal = [...events]
    .reverse()
    .find((event) => event.kind === "action.refused");
  if (refusal === undefined) return null;

  return (
    <dl className="docket">
      <div>
        <dt className="label">NOTHING RAN</dt>
        <dd className="tone-amber">refused</dd>
      </div>
      <div style={{ gridColumn: "span 2" }}>
        <dt className="label">WHY</dt>
        <dd style={{ fontWeight: 400 }}>{refusal.message}</dd>
      </div>
    </dl>
  );
}

function Ledger({ events }: { events: readonly EventView[] }): ReactNode {
  if (events.length === 0) return null;
  return (
    <>
      <h2 className="label" style={{ marginTop: "1.5rem" }}>
        WHAT RINGBOLT DID, AND WHEN
      </h2>
      <ol className="ledger">
        {events.map((event) => (
          <li key={event.id}>
            <span className="at mono">{clockOf(event.at, true)}</span>
            <span>{event.message}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Unit({
  incident,
  now,
  onOpen,
}: {
  incident: IncidentView;
  now: number;
  onOpen: () => void;
}): ReactNode {
  const tone = `tone-${toneForState(incident.state)}`;
  const from =
    incident.state === "calling" ? incident.callStartedAt : incident.updatedAt;
  const run = elapsedFraction(from, incident.wakeAt, now);
  const seconds =
    from === null ? null : Math.max(0, (now - Date.parse(from)) / 1000);

  return (
    <button
      type="button"
      className={`unit ${tone}`}
      onClick={onOpen}
      style={{ borderLeftColor: "currentColor" }}
    >
      <span className="service">{incident.service}</span>
      <span className="why">{incident.title}</span>
      <span className="meter">
        <span>{labelForState(incident.state)}</span>
        <span className="mono">{seconds === null ? "" : asClock(seconds)}</span>
      </span>
      <span className="track">
        <i style={{ width: `${(run ?? 0) * 100}%` }} />
      </span>
    </button>
  );
}

function Rota({
  names,
  usesConfiguredNumber,
}: {
  names: readonly string[];
  usesConfiguredNumber: boolean;
}): ReactNode {
  return (
    <div className="rota">
      <span className="label">WHO GETS CALLED</span>
      {usesConfiguredNumber ? (
        <p style={{ margin: "0.375rem 0 0" }}>
          Nobody is in the rota, so Ringbolt rings the number in this
          deployment&apos;s own configuration.
        </p>
      ) : (
        <ol>
          {names.map((name) => (
            <li key={name}>
              <b>{name}</b>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Strip({ board }: { board: BoardView }): ReactNode {
  const budget = board.budget;
  return (
    <dl className="strip">
      <Cell label="OPEN" value={String(board.counts.open)} />
      <Cell label="ON THE LINE" value={String(board.counts.onTheLine)} />
      <Cell label="ACTED TODAY" value={String(board.counts.actedToday)} />
      <Cell label="REFUSED TODAY" value={String(board.counts.refusedToday)} />
      <Cell
        label="REAL CALLS"
        value={`${budget.realCallsPlaced} placed, $${budget.spentUsd.toFixed(2)}`}
      />
      <Cell
        label="CREDIT LEFT"
        value={
          budget.creditUsd === 0
            ? "none set"
            : `$${budget.remainingUsd.toFixed(2)}, ${budget.callsRemaining} calls`
        }
      />
    </dl>
  );
}

function Cell({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

/**
 * A wall-clock time, in the reader's own zone, because that is the clock they are working in.
 *
 * Twenty four hour whatever the locale says, and that is not a preference. A twelve hour stamp
 * carries a trailing AM or PM that wraps out of a fixed column, and the whole reason these are set
 * in a tabular face is that a column of times holds its width while the numbers change.
 */
function clockOf(at: string | null, withSeconds = false): string {
  if (at === null) return "--:--";
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  return parsed.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}
