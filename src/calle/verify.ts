import { z } from "zod";
import type { CallPlacer, CallSnapshot } from "./port.js";

declare const verified: unique symbol;

/**
 * A call snapshot that came back from the CALL-E API under our own API key, with the shape checked
 * rather than assumed.
 *
 * CALL-E webhook deliveries are unsigned and carry no shared secret, which their own SDK documents
 * by deprecating its signature helpers. A delivered payload is therefore an untrusted claim that
 * something happened, and this product acts on calls by changing production systems. The brand
 * exists so that the type system, rather than a reviewer's memory, is what stops a webhook body
 * being passed to code that authorizes an action.
 */
export type VerifiedCall = CallSnapshot & { readonly [verified]: true };

/**
 * The runtime half of the brand. TypeScript believes the adapter's return type, and the adapter
 * gets its values from a JSON response it did not write, so the confidence score the authorization
 * floor compares against arrives entirely untyped in practice. Everything the gate reads is checked
 * here, at the one door a snapshot can come through.
 */
const callSnapshotShape = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed", "failed", "canceled"]),
  taskCompleted: z.boolean().nullable(),
  confidenceScore: z.number().min(0).max(1).nullable(),
  confidenceLabel: z.string().nullable(),
  summary: z.string().nullable(),
  evidence: z.array(z.string()),
  transcript: z.array(
    z.object({
      offsetSeconds: z.number().nullable(),
      speaker: z.enum(["bot", "user", "unknown"]),
      text: z.string(),
    }),
  ),
  metadata: z.record(z.string(), z.unknown()),
  failureCode: z.string().nullable(),
});

export async function verifyCall(
  placer: CallPlacer,
  callId: string,
): Promise<VerifiedCall> {
  const snapshot = await placer.get(callId);
  if (snapshot.id !== callId) {
    throw new CallVerificationError(
      `asked for ${callId} but the API returned ${snapshot.id}`,
    );
  }

  const checked = callSnapshotShape.safeParse(snapshot);
  if (!checked.success) {
    throw new CallVerificationError(
      `${callId} came back in an unexpected shape: ${checked.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  // The original object rather than the parsed one: structuredResult is deliberately unconstrained
  // here, and it is the authorization gate's own schema that decides whether it means anything.
  return snapshot as VerifiedCall;
}

export class CallVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallVerificationError";
  }
}

/**
 * The only field a webhook body is allowed to decide, and only because the value is then checked
 * against the verified snapshot before anything is done with it.
 */
export function callIdFromDelivery(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * CALL-E documents the event id as a required header and tells receivers to reject a delivery whose
 * header does not match the body. A delivery with no header at all is the same malformed thing, so
 * it is refused rather than quietly trusted on the body alone: the body is the half an anonymous
 * caller writes, and this id is what decides whether work is done once or not at all.
 */
export function eventIdFromDelivery(
  body: unknown,
  header: string | null,
): string | null {
  if (header === null || header === "") return null;
  if (typeof body === "object" && body !== null) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0 && id !== header) return null;
  }
  return header;
}
