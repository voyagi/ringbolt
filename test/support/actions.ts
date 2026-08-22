import type { ActionEnvironment } from "../../src/domain/orchestrator.js";

/**
 * What a runbook action gets in a test. The transport throws by default rather than falling back to
 * the platform's own, so a test that reaches outside says so loudly instead of quietly making a
 * real request to somebody's real system. A test that wants to exercise an http action passes its
 * own stub.
 */
export function testActions(
  overrides: Partial<ActionEnvironment> = {},
): ActionEnvironment {
  return {
    http: () => {
      throw new Error("a test tried to make a real request");
    },
    sleep: async () => undefined,
    secret: () => undefined,
    allowedHosts: null,
    ...overrides,
  };
}

/** A response an http action's transport can answer with, built the way fetch would return one. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
