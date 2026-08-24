/**
 * An in-memory stand-in for the CALL-E HTTP API, installed as the SDK's transport.
 *
 * This is not a second fake CALL-E. `src/calle/fake.ts` stands in for the telephone and is a
 * product component; this stands in for the wire, so that the real adapter, the real SDK and the
 * real request building all run in the tests and only the network is absent. Anything the adapter
 * gets wrong about the API's shape shows up here rather than on the one real call there is budget
 * for.
 */

export type ApiTranscriptTurn = {
  offset_seconds: number | null;
  speaker: "bot" | "user" | "unknown";
  text: string;
};

export type ApiAttempt = {
  id: string;
  phone: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  transcript_turns: ApiTranscriptTurn[];
  provider_call_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
};

export type ApiRecipient = {
  id: string;
  phones: string[];
  locale: string | null;
  region: string | null;
  status: string;
  structured_result: Record<string, unknown> | null;
  summary: string | null;
  attempts: ApiAttempt[];
};

export type ApiCall = {
  id: string;
  object: "call_task";
  status: "queued" | "in_progress" | "completed" | "failed" | "canceled";
  task: string;
  recipients: ApiRecipient[];
  structured_result: Record<string, unknown> | null;
  summary: string | null;
  task_completed: boolean | null;
  completion_confidence: { score: number; label: string } | null;
  evidence: string[];
  metadata: Record<string, unknown>;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  completed_at: string | null;
};

export type RecordedCreate = {
  body: Record<string, unknown>;
  idempotencyKey: string | null;
  authorization: string | null;
};

export type CalleApiStub = {
  /** Hand this to `LiveCallPlacer` as `fetchImpl`. */
  fetch: (input: Request) => Promise<Response>;
  /** Every create the adapter sent, in order, exactly as it went onto the wire. */
  creates: RecordedCreate[];
  /** Replace a stored call, for reading back an outcome the adapter has to map. */
  settle(callId: string, patch: Partial<ApiCall>): void;
  ids(): string[];
  /**
   * Accept the next n creates in full and then fail to answer them.
   *
   * This is what a timeout looks like from the client's side, and CALL-E confirmed on 2026-08-24
   * that it is what actually happened on 2026-08-22: the call was accepted and the answer never
   * arrived. The call is stored before the failure precisely because that is the trap. A client
   * that treats it as "no call was made" and sends again with a fresh key gets billed twice.
   */
  dropAnswers(count: number): void;
};

export function calleApiStub(): CalleApiStub {
  const calls = new Map<string, ApiCall>();
  const idByKey = new Map<string, string>();
  const creates: RecordedCreate[] = [];
  let placed = 0;
  let answersToDrop = 0;

  async function create(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const idempotencyKey = request.headers.get("Idempotency-Key");
    creates.push({
      body,
      idempotencyKey,
      authorization: request.headers.get("authorization"),
    });

    // The real API answers a repeated key with the call it already made rather than dialling
    // again, which is the property that stops a retry becoming a second telephone ringing.
    const knownId =
      idempotencyKey === null ? undefined : idByKey.get(idempotencyKey);
    let call = knownId === undefined ? undefined : calls.get(knownId);
    if (call === undefined) {
      placed += 1;
      call = queuedCall(`call_stub_${placed}`, body);
      calls.set(call.id, call);
      if (idempotencyKey !== null) idByKey.set(idempotencyKey, call.id);
    }

    // The failure is raised after the call exists, which is the whole point of it.
    if (answersToDrop > 0) {
      answersToDrop -= 1;
      throw new Error("The operation was aborted due to timeout");
    }

    return json(201, call);
  }

  function read(callId: string): Response {
    const call = calls.get(callId);
    if (call === undefined) {
      return apiError(404, "not_found", `No call task with id ${callId}.`);
    }
    return json(200, call);
  }

  return {
    creates,
    ids: () => [...calls.keys()],
    dropAnswers(count) {
      answersToDrop = count;
    },
    settle(callId, patch) {
      const call = calls.get(callId);
      if (call === undefined) throw new Error(`no stub call ${callId}`);
      calls.set(callId, { ...call, ...patch });
    },
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/v1/calls") {
        return await create(request);
      }

      const oneCall = /^\/v1\/calls\/([^/]+)$/.exec(pathname);
      if (request.method === "GET" && oneCall?.[1] !== undefined) {
        return read(decodeURIComponent(oneCall[1]));
      }

      return apiError(
        404,
        "not_found",
        `No route for ${request.method} ${pathname}.`,
      );
    },
  };
}

function queuedCall(id: string, body: Record<string, unknown>): ApiCall {
  const recipients = Array.isArray(body["recipients"])
    ? (body["recipients"] as { phones?: string[] }[])
    : [];

  return {
    id,
    object: "call_task",
    status: "queued",
    task: typeof body["task"] === "string" ? body["task"] : "",
    recipients: recipients.map((recipient, index) => ({
      id: `rcp_${index + 1}`,
      phones: recipient.phones ?? [],
      locale: null,
      region: null,
      status: "pending",
      structured_result: null,
      summary: null,
      attempts: [],
    })),
    structured_result: null,
    summary: null,
    task_completed: null,
    completion_confidence: null,
    evidence: [],
    metadata: isObject(body["metadata"]) ? body["metadata"] : {},
    failure_code: null,
    failure_message: null,
    created_at: "2026-08-21T12:00:00.000Z",
    completed_at: null,
  };
}

export function anAttempt(patch: Partial<ApiAttempt> = {}): ApiAttempt {
  return {
    id: "att_1",
    phone: "+31600000000",
    status: "completed",
    started_at: "2026-08-21T12:00:05.000Z",
    completed_at: "2026-08-21T12:01:05.000Z",
    summary: null,
    transcript_turns: [],
    provider_call_id: null,
    failure_code: null,
    failure_message: null,
    ...patch,
  };
}

export function aRecipient(attempts: ApiAttempt[]): ApiRecipient {
  return {
    id: "rcp_1",
    phones: ["+31600000000"],
    locale: null,
    region: null,
    status: "completed",
    structured_result: null,
    summary: null,
    attempts,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The envelope the SDK reads to build its error classes. */
function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message, details: {} } });
}
