import { type ReactNode, useState } from "react";
import {
  type IncidentView,
  labelForState,
  openIncidentStates,
  sinceWords,
  toneForSeverity,
  toneForState,
} from "../../domain/view.js";
import { get } from "../api.js";
import { usePoll } from "../poll.js";
import { Nothing, Waiting, Wrong } from "../parts/states.js";

type Sieve = "open" | "closed" | "all";

const SIEVES: { id: Sieve; label: string }[] = [
  { id: "open", label: "Still open" },
  { id: "closed", label: "Finished" },
  { id: "all", label: "Everything" },
];

const OPEN = new Set<string>(openIncidentStates);

export function Incidents({ go }: { go: (path: string) => void }): ReactNode {
  const [sieve, setSieve] = useState<Sieve>("open");
  const loaded = usePoll<{ incidents: IncidentView[] }>(
    () => get("/api/audit/incidents"),
    null,
  );

  if (loaded.status === "loading") return <Waiting what="the history" />;
  if (loaded.status === "failed")
    return <Wrong error={loaded.error} again={loaded.again} />;

  const now = Date.now();
  const shown = loaded.value.incidents.filter((incident) =>
    sieve === "all" ? true : OPEN.has(incident.state) === (sieve === "open"),
  );

  return (
    <>
      <header>
        <h1>Incidents</h1>
        <p>
          Every alert Ringbolt has accepted, what it did about it, and who it
          telephoned. The two hundred most recent.
        </p>
      </header>

      <div
        className="filters"
        role="group"
        aria-label="Which incidents to show"
      >
        {SIEVES.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={sieve === option.id}
            onClick={() => setSieve(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Nothing heading="Nothing here yet">
          {sieve === "open"
            ? "No incident is open. Post an alert to the intake endpoint and it lands here."
            : "No incident has finished yet."}
        </Nothing>
      ) : (
        <table className="log">
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Service</th>
              <th scope="col">What broke</th>
              <th scope="col">Severity</th>
              <th scope="col">Called</th>
              <th scope="col">Opened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((incident) => (
              <Row key={incident.id} incident={incident} now={now} go={go} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Row({
  incident,
  now,
  go,
}: {
  incident: IncidentView;
  now: number;
  go: (path: string) => void;
}): ReactNode {
  return (
    <tr>
      <td className={`spine tone-${toneForState(incident.state)}`}>
        <span className="label">{labelForState(incident.state)}</span>
      </td>
      <td>
        <a
          href={`/incidents/${incident.id}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            go(`/incidents/${incident.id}`);
          }}
        >
          {incident.service}
        </a>
      </td>
      <td>
        {incident.title}
        {incident.outcome !== null && (
          <div className="note">{incident.outcome}</div>
        )}
      </td>
      <td className={`tone-${toneForSeverity(incident.severity)}`}>
        {incident.severity}
      </td>
      <td>{incident.contactName ?? "nobody yet"}</td>
      <td className="mono">{sinceWords(incident.createdAt, now)}</td>
    </tr>
  );
}
