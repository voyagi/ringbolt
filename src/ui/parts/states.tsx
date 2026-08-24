import type { ReactNode } from "react";
import type { ApiError } from "../api.js";

/**
 * The three answers a screen can give when it has nothing to draw. They are separate components
 * because "not yet", "nothing at all" and "this broke" are three different sentences, and only one
 * of them means wait.
 */

export function Waiting({ what }: { what: string }): ReactNode {
  return (
    <div className="state" role="status">
      <div className="waiting" />
      <p>Reading {what}.</p>
    </div>
  );
}

export function Nothing({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="state">
      <h2>{heading}</h2>
      <p>{children}</p>
    </div>
  );
}

export function Wrong({
  error,
  again,
}: {
  error: ApiError;
  again?: () => void;
}): ReactNode {
  return (
    <div className="state wrong" role="alert">
      <h2>That did not work</h2>
      <p>{error.message}</p>
      {error.issues.length > 0 && (
        <ul>
          {error.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {again !== undefined && (
        <p>
          <button type="button" className="btn" onClick={again}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

/** A poll that failed while a good board is still on screen. It says how old the board is. */
export function Stale({
  error,
  at,
  now,
}: {
  error: ApiError;
  at: number;
  now: number;
}): ReactNode {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return (
    <span className="tone-amber" role="status">
      {error.message} Showing the board from {seconds}s ago.
    </span>
  );
}
