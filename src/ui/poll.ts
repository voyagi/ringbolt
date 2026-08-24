import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api.js";

/**
 * How the board stays live.
 *
 * It polls rather than holding a socket, and that is a decision rather than a shortcut. The deck is
 * an aggregate across every incident, and each incident is owned by its own Durable Object, so a
 * socket would need a second object every incident reports into: a new piece of state on the path
 * that decides whether a telephone rings, built for a screen. A conditional GET every two seconds
 * costs a row count and answers the question the roadmap actually asks, which is that the board
 * moves during a call without anybody reloading it.
 */
export const BOARD_INTERVAL_MS = 2000;

export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T; at: number }
  | { status: "failed"; error: ApiError };

/**
 * Reads something once and then again on a timer, keeping the last good value on screen while a
 * refresh is in flight. A poll that blanked the board on every tick would make the deck unreadable
 * and would hide a running call behind a spinner twice a second.
 *
 * A refresh that fails does NOT throw away what is already shown: it is surfaced beside it, because
 * an operator reading a two second old board knowingly is better off than one reading an error page.
 */
export function usePoll<T>(
  read: () => Promise<T>,
  intervalMs: number | null,
): Loaded<T> & { stale: ApiError | null; again: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [stale, setStale] = useState<ApiError | null>(null);
  const alive = useRef(true);
  const latest = useRef(read);
  latest.current = read;

  const again = useCallback(() => {
    void latest
      .current()
      .then((value) => {
        if (!alive.current) return;
        setState({ status: "ready", value, at: Date.now() });
        setStale(null);
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError(0, "something went wrong reading that");
        // Only the first read gets to paint a failure. After that the last good board stays up and
        // the failure is reported next to it.
        setState((current) =>
          current.status === "ready"
            ? current
            : { status: "failed", error: failure },
        );
        setStale(failure);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    again();
    if (intervalMs === null) return () => void (alive.current = false);

    const timer = setInterval(again, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [again, intervalMs]);

  return { ...state, stale, again };
}

/**
 * A clock that ticks once a second, so a ring counting the seconds of a live call moves between
 * polls instead of jumping every two.
 *
 * It counts from the SERVER's clock rather than the browser's. A laptop several minutes out is
 * ordinary, and a call that reads as having run for minus four minutes reads as a bug in Ringbolt
 * rather than as a clock disagreeing.
 */
export function useServerClock(serverNow: string | null): number {
  const [drift, setDrift] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (serverNow === null) return;
    const parsed = Date.parse(serverNow);
    if (Number.isNaN(parsed)) return;
    setDrift(parsed - Date.now());
  }, [serverNow]);

  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return Date.now() + drift;
}
