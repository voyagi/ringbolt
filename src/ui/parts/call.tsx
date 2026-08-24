import type { ReactNode } from "react";
import {
  type ActionRunView,
  type CallView,
  type TranscriptTurnView,
  asClock,
  normalisePhrase,
  verifiedFlag,
} from "../../domain/view.js";

const SPEAKER: Record<TranscriptTurnView["speaker"], string> = {
  bot: "Ringbolt",
  user: "Responder",
  unknown: "Unattributed",
};

/**
 * Which turn granted permission, or null when nothing in the transcript proves one did.
 *
 * A screen that pointed at the last thing the responder said and called it the authorization would
 * be guessing, and this product refuses to act on a guess about what somebody said. So the mark is
 * drawn only where the words the action actually required are present, matched the same way the
 * authorization gate matches them.
 */
export function grantingTurn(
  transcript: readonly TranscriptTurnView[],
  phrase: string | null,
): number | null {
  if (phrase === null) return null;
  const wanted = normalisePhrase(phrase);
  if (wanted === "") return null;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const turn = transcript[index];
    if (turn === undefined || turn.speaker !== "user") continue;
    if (normalisePhrase(turn.text).includes(wanted)) return index;
  }
  return null;
}

/**
 * Which call authorized which action run, matched on WHEN rather than on position.
 *
 * By position it is wrong the moment an incident is escalated: an unanswered first call and a
 * second one that ended in a rollback gives two calls and one run, and pairing them by index hangs
 * the rollback docket under the call nobody answered. That reads as "Nadia authorized a rollback on
 * a call she never picked up", which is precisely the false claim this whole product exists to
 * avoid making.
 *
 * A run is authorized by the last call that had ended before it ran, which is what the audit trail
 * records and what the orchestrator does. The call id itself never leaves the service, so time is
 * the join, not an identifier.
 */
export function runsByCall(
  calls: readonly { recordedAt: string }[],
  runs: readonly ActionRunView[],
): ActionRunView[][] {
  const byCall: ActionRunView[][] = calls.map(() => []);
  for (const run of runs) {
    const ran = Date.parse(run.at);
    let owner = -1;
    for (let index = 0; index < calls.length; index += 1) {
      const ended = Date.parse(calls[index]?.recordedAt ?? "");
      if (!Number.isNaN(ended) && !Number.isNaN(ran) && ended <= ran)
        owner = index;
    }
    // A run with no call before it belongs to no call on this page rather than to the first one.
    byCall[owner]?.push(run);
  }
  return byCall;
}

/** The confirmation phrase a run was authorized on, when its decision carried one. */
export function spokenPhrase(run: ActionRunView | undefined): string | null {
  const decision = run?.decision;
  if (decision === null || typeof decision !== "object") return null;
  const phrase = (decision as Record<string, unknown>)["confirmation_phrase"];
  return typeof phrase === "string" && phrase.trim() !== "" ? phrase : null;
}

/**
 * Every turn drawn at its real position in the call, so who spoke when is measured rather than
 * illustrated. Each turn runs until the next one starts; the last runs to the end of the call.
 */
export function TalkTrack({
  transcript,
  grant,
}: {
  transcript: readonly TranscriptTurnView[];
  grant: number | null;
}): ReactNode {
  const spans = turnSpans(transcript);
  if (spans.length === 0) return null;

  return (
    <div
      className="talk-track"
      role="img"
      aria-label={`Who spoke when: ${spans.length} turns over ${asClock(spans[spans.length - 1]?.end ?? 0)}.`}
    >
      {spans.map((span, index) => (
        <i
          key={`${span.start}-${index}`}
          className={index === grant ? "grant" : span.speaker}
          style={{ flexGrow: Math.max(1, span.end - span.start) }}
        />
      ))}
    </div>
  );
}

type Span = {
  start: number;
  end: number;
  speaker: TranscriptTurnView["speaker"];
};

/**
 * Turn offsets turned into spans. A turn with no offset at all takes an equal share rather than
 * collapsing to nothing: CALL-E sends the offset per turn and a missing one is a gap in what they
 * told us, not evidence that nobody spoke.
 */
export function turnSpans(transcript: readonly TranscriptTurnView[]): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < transcript.length; index += 1) {
    const turn = transcript[index];
    if (turn === undefined) continue;
    const start = turn.offsetSeconds ?? index;
    const nextTurn = transcript[index + 1];
    const next = nextTurn?.offsetSeconds ?? index + 1;
    spans.push({
      start,
      end: next > start ? next : start + 1,
      speaker: turn.speaker,
    });
  }
  return spans;
}

export function Transcript({
  call,
  grant,
}: {
  call: CallView;
  grant: number | null;
}): ReactNode {
  if (call.transcript.length === 0) {
    // Two sentences rather than one with an emphasised phrase inside it. An
    // inline element that wraps across lines is one axe declines to judge for
    // contrast, and an undetermined result is not a clean one.
    return (
      <>
        <p className="heard">This call carries no transcript.</p>
        <p className="heard tone-amber">
          Nothing can be authorized on a call the responder was not heard on.
        </p>
      </>
    );
  }

  return (
    <div className="talk">
      {call.transcript.map((turn, index) => (
        <p
          className={`said ${turn.speaker}${index === grant ? " grant" : ""}`}
          key={`${turn.offsetSeconds ?? index}-${index}`}
        >
          <span className="at mono">
            {turn.offsetSeconds === null
              ? "--:--"
              : asClock(turn.offsetSeconds)}
          </span>
          <span className="words">
            <span className="label">{SPEAKER[turn.speaker]}</span> {turn.text}
          </span>
        </p>
      ))}
      {grant !== null && <div className="tie" />}
    </div>
  );
}

/**
 * The docket. What ran, on whose authority, how sure the provider was, and what the check
 * afterwards found. Its first cell carries the red top edge that receives the tie.
 */
export function Docket({
  run,
  confidence,
}: {
  run: ActionRunView;
  confidence: number | null;
}): ReactNode {
  const verified = verifiedFlag(run.verification);
  const outcomeTone =
    run.outcome === "succeeded"
      ? "tone-green"
      : run.outcome === "failed"
        ? "tone-live"
        : "tone-amber";

  return (
    <dl className="docket">
      <Cell label="ACTION RUN" tone="tone-live" value={run.actionId} />
      <Cell
        label="AUTHORITY"
        value={run.authorizedBy === null ? "not recorded" : run.authorizedBy}
      />
      <Cell
        label="CONFIDENCE"
        mono
        value={confidence === null ? "unknown" : confidence.toFixed(2)}
      />
      <Cell label="OUTCOME" tone={outcomeTone} value={run.outcome} />
      <Cell
        label="CHECKED"
        value={
          verified === null ? "nobody looked" : verified ? "confirmed" : "no"
        }
      />
    </dl>
  );
}

function Cell({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: string;
  mono?: boolean;
}): ReactNode {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className={`${tone ?? ""}${mono === true ? " mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
