import type { ReactNode } from "react";
import type { Saving } from "../save.js";

/**
 * What the server said about the last save. Its refusals are the interesting half: the
 * configuration endpoints check things a browser cannot, so their words are shown verbatim rather
 * than summarised into "something went wrong".
 */
export function Verdict({
  saving,
  done,
}: {
  saving: Saving;
  done: string;
}): ReactNode {
  if (saving.error !== null) {
    return (
      <div role="alert" className="stack">
        <p className="wrong">{saving.error.message}</p>
        {saving.error.issues.length > 0 && (
          <ul className="wrong">
            {saving.error.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (saving.saved) {
    return (
      <p className="saved" role="status">
        {done}
      </p>
    );
  }
  return null;
}
