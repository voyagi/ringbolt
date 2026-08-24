/**
 * Every request the dashboard makes, and the one place the administrator token is attached.
 *
 * The token lives in sessionStorage rather than localStorage on purpose. It authorizes changing
 * which telephone rings, so it should not outlive the tab it was typed into: an operator who closes
 * the browser has signed out, which is the behaviour they would expect and the one that costs
 * nothing to provide.
 */

const TOKEN_KEY = "ringbolt-admin-token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The deployment wants a token and has not been given a usable one. */
  get needsToken(): boolean {
    return this.status === 401;
  }
}

export function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // A browser refusing storage still gets a working dashboard for the length of one page view.
    return memoryToken;
  }
}

let memoryToken: string | null = null;

export function rememberToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Held in memory above, which is the whole session this tab is going to have anyway.
  }
}

type Body = Record<string, unknown> | unknown[];

export async function get<T>(path: string): Promise<T> {
  return send<T>("GET", path);
}

export async function put<T>(path: string, body: Body): Promise<T> {
  return send<T>("PUT", path, body);
}

export async function post<T>(path: string, body: Body): Promise<T> {
  return send<T>("POST", path, body);
}

export async function remove<T>(path: string): Promise<T> {
  return send<T>("DELETE", path);
}

async function send<T>(method: string, path: string, body?: Body): Promise<T> {
  const token = storedToken();
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    // A dropped connection and a refused one are the same thing to a person looking at a board:
    // what they are reading is not what is happening.
    throw new ApiError(0, "Ringbolt is not answering. Check it is running.");
  }

  const payload = await readPayload(response);
  if (response.ok) return payload as T;

  const named = payload as { error?: unknown; issues?: unknown };
  const message =
    typeof named?.error === "string"
      ? named.error
      : `the request failed with ${response.status}`;
  const issues = Array.isArray(named?.issues)
    ? named.issues.filter((issue): issue is string => typeof issue === "string")
    : [];
  throw new ApiError(response.status, message, issues);
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 200) };
  }
}
