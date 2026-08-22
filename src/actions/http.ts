import type { ActionContext, ActionResult, Verification } from "./context.js";
import {
  type HttpTarget,
  type HttpVerify,
  type JsonValue,
  type ParameterValue,
  actionUrlProblem,
} from "./definition.js";

type Values = Readonly<Record<string, ParameterValue>>;

/** Enough of a response to put in an audit record, and not enough to exhaust a Worker's memory. */
const MAX_RESPONSE_BYTES = 8 * 1024;

const RETRY_AFTER_MS = 500;

const placeholder = /\{([a-z][a-z0-9_]{0,39})\}/g;

type Plan = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type Probed = { url: string; value: unknown; error: string | null };

/**
 * An action that reaches a system Ringbolt does not own. Everything here is written on the
 * assumption that the request changes production, because that is what a runbook action is for.
 *
 * Redirects are not followed. The host was authorized by a policy and checked against the
 * deployment's allowlist, and a redirect is the target choosing a different one after the fact.
 *
 * A request is attempted once unless the definition says the action is idempotent, and a response
 * that never arrived is not treated as one that did not happen.
 */
export async function runHttp(
  target: HttpTarget,
  verify: HttpVerify | null,
  values: Values,
  context: ActionContext,
): Promise<ActionResult> {
  const plan = buildPlan(target, values, context);
  if (typeof plan === "string") {
    return {
      outcome: "failed",
      detail: plan,
      stateBefore: null,
      stateAfter: null,
      attempts: 0,
      verification: null,
    };
  }

  const before = verify === null ? null : await probe(verify, values, context);
  const sent = await send(plan, target, context);
  if (!sent.ok) {
    return {
      outcome: "failed",
      detail: sent.detail,
      stateBefore: before,
      stateAfter: before,
      attempts: sent.attempts,
      verification: null,
    };
  }

  if (verify === null) {
    return {
      outcome: "succeeded",
      detail: sent.detail,
      stateBefore: null,
      stateAfter: null,
      attempts: sent.attempts,
      verification: null,
    };
  }

  const checked = await confirm(verify, values, context);
  return {
    outcome: checked.verification.verified ? "succeeded" : "unverified",
    detail: `${sent.detail}. ${checked.verification.detail}`,
    stateBefore: before,
    stateAfter: checked.state,
    attempts: sent.attempts,
    verification: checked.verification,
  };
}

function buildPlan(
  target: HttpTarget,
  values: Values,
  context: ActionContext,
): Plan | string {
  const url = fillUrl(target.url, values);
  const problem = urlProblem(url, context);
  if (problem !== null) return problem;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.headers)) {
    if (typeof value === "string") {
      headers[name] = fillText(value, values);
      continue;
    }
    const secret = context.secret(value.fromSecret);
    if (secret === undefined) {
      return `this action reads ${value.fromSecret} and this deployment does not have that binding, so nothing was sent`;
    }
    headers[name] = secret;
  }

  const body =
    target.body === undefined
      ? undefined
      : JSON.stringify(fillJson(target.body, values));
  if (body !== undefined && !hasHeader(headers, "content-type")) {
    headers["content-type"] = "application/json";
  }

  return { url, method: target.method, headers, body };
}

type Sent = { ok: boolean; detail: string; attempts: number };

async function send(
  plan: Plan,
  target: HttpTarget,
  context: ActionContext,
): Promise<Sent> {
  const limit = target.idempotent ? target.maxAttempts : 1;
  let attempt = 0;
  let last: { detail: string; retryable: boolean } = {
    detail: "the request was never attempted",
    retryable: false,
  };

  while (attempt < limit) {
    attempt += 1;
    const outcome = await attemptOnce(plan, target, context);
    if (outcome.ok) {
      return { ok: true, detail: outcome.detail, attempts: attempt };
    }
    last = outcome;
    if (!outcome.retryable || attempt >= limit) break;
    await context.sleep(RETRY_AFTER_MS * attempt);
  }

  return {
    ok: false,
    detail: attempt > 1 ? `${last.detail} (${attempt} attempts)` : last.detail,
    attempts: attempt,
  };
}

type Attempt =
  | { ok: true; detail: string }
  | { ok: false; detail: string; retryable: boolean };

async function attemptOnce(
  plan: Plan,
  target: HttpTarget,
  context: ActionContext,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await context.http(plan.url, {
      method: plan.method,
      headers: plan.headers,
      ...(plan.body === undefined ? {} : { body: plan.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(target.timeoutMs),
    });
  } catch (error) {
    // Nothing came back, so whether the far side carried the request out is unknown. That is why
    // only an action that declares itself idempotent is allowed to try again.
    const detail =
      error instanceof Error ? error.message : "the request did not complete";
    return { ok: false, detail, retryable: true };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      detail: `the target redirected to somewhere else, which is not followed: ${response.status}`,
      retryable: false,
    };
  }

  const body = await readBounded(response);
  const expected =
    target.expectStatus === undefined
      ? response.status >= 200 && response.status < 300
      : target.expectStatus.includes(response.status);

  if (expected) {
    return { ok: true, detail: `answered ${response.status}` };
  }
  return {
    ok: false,
    detail: `answered ${response.status}: ${body}`,
    retryable: response.status === 429 || response.status >= 500,
  };
}

async function confirm(
  verify: HttpVerify,
  values: Values,
  context: ActionContext,
): Promise<{ verification: Verification; state: Probed }> {
  let state: Probed = { url: "", value: null, error: null };

  for (let attempt = 1; attempt <= verify.attempts; attempt += 1) {
    state = await probe(verify, values, context);
    if (state.error === null && state.value === verify.equals) {
      return {
        verification: {
          verified: true,
          detail: `${verify.jsonPath.join(".")} reads back as ${String(verify.equals)}`,
        },
        state,
      };
    }
    if (attempt < verify.attempts) await context.sleep(verify.delayMs);
  }

  const found = state.error ?? JSON.stringify(state.value ?? null);
  return {
    verification: {
      verified: false,
      detail: `the request was accepted, but ${verify.jsonPath.join(".")} still reads ${found} rather than ${String(verify.equals)}`,
    },
    state,
  };
}

async function probe(
  verify: HttpVerify,
  values: Values,
  context: ActionContext,
): Promise<Probed> {
  const url = fillUrl(verify.url, values);
  const problem = urlProblem(url, context);
  if (problem !== null) return { url, value: null, error: problem };

  try {
    const response = await context.http(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(verify.timeoutMs),
    });
    const body = await readBounded(response);
    if (response.status < 200 || response.status >= 300) {
      return {
        url,
        value: null,
        error: `the check answered ${response.status}`,
      };
    }
    return {
      url,
      value: valueAt(JSON.parse(body), verify.jsonPath),
      error: null,
    };
  } catch (error) {
    return {
      url,
      value: null,
      error:
        error instanceof Error ? error.message : "the check did not answer",
    };
  }
}

/**
 * The deployment's own answer to a target it cannot resolve safely. The structural check runs again
 * here rather than only when the definition was stored, because a parameter is substituted in
 * between and the allowlist can be tightened after a definition already exists.
 */
function urlProblem(url: string, context: ActionContext): string | null {
  const structural = actionUrlProblem(url);
  if (structural !== null) return `the url ${structural}`;

  if (context.allowedHosts === null) return null;
  const host = new URL(url).hostname.toLowerCase();
  if (context.allowedHosts.includes(host)) return null;
  return `this deployment may not call ${host}. Names it may call go in ACTION_HOST_ALLOWLIST.`;
}

function fillUrl(template: string, values: Values): string {
  return template.replace(placeholder, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : encodeURIComponent(String(value));
  });
}

function fillText(template: string, values: Values): string {
  return template.replace(placeholder, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Substitution into the body walks the parsed structure rather than the text of it, so a value
 * containing a quotation mark cannot rewrite the request around itself. A string that is nothing
 * but one placeholder takes the parameter's own type, so a number declared as a number arrives as
 * one.
 */
function fillJson(value: JsonValue, values: Values): JsonValue {
  if (Array.isArray(value)) return value.map((item) => fillJson(item, values));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillJson(item, values)]),
    );
  }
  if (typeof value !== "string") return value;

  const whole = /^\{([a-z][a-z0-9_]{0,39})\}$/.exec(value);
  const named = whole === null ? undefined : values[whole[1] ?? ""];
  return named === undefined ? fillText(value, values) : named;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(
    (header) => header.toLowerCase() === name.toLowerCase(),
  );
}

function valueAt(document: unknown, path: readonly string[]): unknown {
  let current = document;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Reads at most MAX_RESPONSE_BYTES and drops the rest, rather than trusting a length header. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";

  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    read += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
    if (read >= MAX_RESPONSE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return text.slice(0, MAX_RESPONSE_BYTES);
}
