import { useCallback, useState } from "react";
import { ApiError } from "./api.js";

export type Saving = {
  busy: boolean;
  error: ApiError | null;
  saved: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  clear: () => void;
};

/**
 * The shape every configuration form needs: in flight, refused, or done. It exists once rather than
 * eleven times so that a form which forgets to render the refusal cannot exist, and so the server's
 * own words are what the operator reads. The server refuses far more than the browser could check,
 * and it explains why, so nothing here second-guesses it with a message of its own.
 */
export function useSaving(): Saving {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await work();
      setSaved(true);
      return true;
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure
          : new ApiError(0, "that could not be saved"),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => {
    setError(null);
    setSaved(false);
  }, []);

  return { busy, error, saved, run, clear };
}
