import type { Repo } from "../db/repo.js";

/**
 * How many requests a bucket may make inside a window, and how wide that window is.
 *
 * Fixed windows rather than a sliding one. A fixed window lets through up to twice the allowance
 * across a boundary, which is a known and bounded cost; a sliding window needs a row per request or
 * a Durable Object on the path, and neither is worth paying for a limit whose job is to catch a
 * runaway sender rather than to meter a paid API.
 */
export type Limit = { limit: number; windowMs: number };

/**
 * What one sender may open in a minute. Well above a real monitor, which sends an alert and then
 * repeats it every few minutes: repeats collapse into the open incident anyway, so a sender at this
 * rate is either misconfigured or looping.
 */
export const INTAKE_PER_SENDER: Limit = { limit: 60, windowMs: 60_000 };

/**
 * What the whole deployment may take in a minute, whoever is sending. The per-sender limit is no
 * defence against the same token used from many addresses, and every alert that gets through can
 * ring a telephone.
 */
export const INTAKE_OVERALL: Limit = { limit: 300, windowMs: 60_000 };

/**
 * How many times one address may present a wrong administrator token before it is answered with a
 * refusal to keep trying.
 *
 * It is not what makes the token safe. A sixteen character secret compared in constant time is not
 * going to be guessed, and this would not stop a determined attacker who changes address. What it
 * does is stop a spray from being free and silent, and it costs nothing on the path that matters:
 * a correct token never touches this at all.
 */
export const ADMIN_FAILURES: Limit = { limit: 10, windowMs: 5 * 60_000 };

/** How long rate windows are kept before the sweep removes them. */
export const WINDOW_RETENTION_MS = 60 * 60 * 1000;

export type LimitVerdict = {
  allowed: boolean;
  /** Whole seconds until the current window ends, for the Retry-After header. */
  retryAfterSeconds: number;
};

/**
 * Counts one request against a bucket and says whether it is within the allowance.
 *
 * The count happens either way, so a caller that keeps going while being refused keeps being
 * refused rather than sliding under the limit as the refused requests go uncounted.
 */
export async function countAgainst(
  repo: Repo,
  bucket: string,
  limit: Limit,
  now: Date,
): Promise<LimitVerdict> {
  const start = Math.floor(now.getTime() / limit.windowMs) * limit.windowMs;
  const hits = await repo.countAgainstWindow(
    bucket,
    new Date(start).toISOString(),
  );
  return {
    allowed: hits <= limit.limit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((start + limit.windowMs - now.getTime()) / 1000),
    ),
  };
}

/**
 * Which sender a request is from, as far as the platform will say.
 *
 * Cloudflare sets this header itself and a client cannot forge it, which is what makes it usable as
 * a bucket key. Without it every caller shares one bucket, which is stricter rather than looser:
 * the limit still holds, it just holds across everybody at once. Failing towards refusing is the
 * right direction for a limit that exists to stop a telephone ringing.
 */
export function senderOf(headers: Headers): string {
  return headers.get("CF-Connecting-IP") ?? "unattributed";
}

/**
 * The bucket names, written once. A test that burns an allowance and the code that counts against
 * it have to agree on the key, and two string templates that look the same are two chances to be
 * counting different things while both look right.
 */
export function intakeBucket(sender: string): string {
  return `intake:${sender}`;
}

export const INTAKE_ALL = "intake";

export function adminBucket(sender: string): string {
  return `admin:${sender}`;
}
