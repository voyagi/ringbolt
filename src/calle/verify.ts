import type { CallPlacer, CallSnapshot } from "./port.js";

declare const verified: unique symbol;

/**
 * A call snapshot that came back from the CALL-E API under our own API key.
 *
 * CALL-E webhook deliveries are unsigned and carry no shared secret, which their own SDK documents
 * by deprecating its signature helpers. A delivered payload is therefore an untrusted claim that
 * something happened, and this product acts on calls by changing production systems. The brand
 * exists so that the type system, rather than a reviewer's memory, is what stops a webhook body
 * being passed to code that authorizes an action.
 */
export type VerifiedCall = CallSnapshot & { readonly [verified]: true };

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

export function eventIdFromDelivery(
  body: unknown,
  header: string | null,
): string | null {
  if (typeof body === "object" && body !== null) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      // CALL-E's guidance is to check the header against the body rather than trust either alone.
      if (header !== null && header !== id) return null;
      return id;
    }
  }
  return header;
}
