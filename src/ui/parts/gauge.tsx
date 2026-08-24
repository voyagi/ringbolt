import type { ReactNode } from "react";
import { asClock } from "../../domain/view.js";

const RADIUS_OUTER = 110;
const RADIUS_INNER = 86;
const CIRCUMFERENCE_OUTER = 2 * Math.PI * RADIUS_OUTER;
const CIRCUMFERENCE_INNER = 2 * Math.PI * RADIUS_INNER;

/**
 * The primary instrument. One dial the eye lands on first, with everything else arranged around it
 * as supporting readout, which is the difference between an instrument cluster and a wall of
 * equal-weight boxes.
 *
 * The outer ring counts the incident against its own deadline: the escalation clock while somebody
 * is on the phone, the wake time while it is parked. The inner arc is the call, and it is drawn
 * only when there is a call to draw, never as decoration.
 */
export function Gauge({
  seconds,
  outer,
  inner,
  tone,
  state,
  under,
}: {
  seconds: number | null;
  outer: number | null;
  inner: number | null;
  tone: string;
  state: string;
  under: string;
}): ReactNode {
  return (
    <div
      className="gauge"
      role="img"
      aria-label={`${state}. ${seconds === null ? "" : `${asClock(seconds)}. `}${under}`}
    >
      <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false">
        <circle
          className="rest"
          cx="128"
          cy="128"
          r={RADIUS_OUTER}
          fill="none"
          strokeWidth="16"
        />
        {outer !== null && (
          <circle
            className={`arc ${tone}`}
            cx="128"
            cy="128"
            r={RADIUS_OUTER}
            fill="none"
            stroke="currentColor"
            strokeWidth="16"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE_OUTER}
            strokeDashoffset={CIRCUMFERENCE_OUTER * (1 - clamp(outer))}
          />
        )}
        <circle
          className="rest"
          cx="128"
          cy="128"
          r={RADIUS_INNER}
          fill="none"
          strokeWidth="4"
        />
        {inner !== null && (
          <circle
            className="arc tone-cyan"
            cx="128"
            cy="128"
            r={RADIUS_INNER}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE_INNER}
            strokeDashoffset={CIRCUMFERENCE_INNER * (1 - clamp(inner))}
          />
        )}
      </svg>
      <div className="readout">
        <div className={`state ${tone}`}>{state}</div>
        <div className="count">
          {seconds === null ? "--:--" : asClock(seconds)}
        </div>
        <div className="under">{under}</div>
      </div>
    </div>
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
