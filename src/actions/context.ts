import type { Repo } from "../db/repo.js";

/**
 * What an action gets to work with. Two of these are dependencies rather than globals on purpose.
 *
 * `http` is the transport an action's request goes out on. There is no default: a default would be
 * the platform's own fetch, and the caller least likely to notice that is a test, which is how a
 * suite ends up reaching a real service.
 *
 * `allowedHosts` is the deployment's own list of hosts it may call, or null in development where
 * there is none. It is the same argument as the phone number allowlist: an action definition is a
 * database row, so without this the set of systems a deployment can reach is whatever somebody
 * typed into the configuration API.
 */
export type ActionContext = {
  repo: Repo;
  service: string;
  now: () => Date;
  http: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  secret: (binding: string) => string | undefined;
  allowedHosts: readonly string[] | null;
};

/** What checking afterwards found. Null when the definition declared nothing to check. */
export type Verification = {
  verified: boolean;
  detail: string;
};

export type ActionResult = {
  /**
   * `unverified` is neither of the other two: the action reported success and the check that was
   * supposed to confirm it did not. Ringbolt will not call that resolved, because the one thing it
   * must never do is tell somebody a production problem is fixed when nobody has looked.
   */
  outcome: "succeeded" | "failed" | "unverified";
  detail: string;
  stateBefore: unknown;
  stateAfter: unknown;
  attempts: number;
  verification: Verification | null;
};
