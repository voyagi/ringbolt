import { z } from "zod";

/**
 * E.164, and strict about it. A country code cannot begin with a zero, which is what makes the
 * placeholder the local stand-in carries impossible to dial by accident.
 */
export const phoneNumber = z
  .string()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "must be an E.164 phone number, for example +31612345678",
  );

export const contactInput = z.object({
  name: z.string().min(1).max(80),
  phone: phoneNumber,
});

export type ContactInput = z.infer<typeof contactInput>;

/**
 * A rota is short by design. Ten is well past the point where the last person would ever be
 * reached, and a bound is what stops one configuration write becoming an unbounded call chain.
 */
export const rotationInput = z.object({
  contactIds: z.array(z.string().min(1).max(60)).max(10),
});

export type Contact = {
  id: string;
  name: string;
  phone: string;
  createdAt: string;
};

/**
 * The id given to the number in the configuration rather than to a contact anyone created. It is a
 * real id in the audit trail and deliberately not a row in the contacts table, so deleting every
 * contact cannot leave Ringbolt with nobody to telephone.
 */
export const CONFIGURED_CONTACT_ID = "configured";

/**
 * The people a service calls, in order.
 *
 * An empty rotation is not a fault. A fresh install has no contacts and still has to be able to
 * ring the one number the operator configured, which is what makes the rotation additive: it
 * lengthens the list rather than being the prerequisite for having one at all.
 */
export function effectiveRotation(
  contacts: readonly Contact[],
  fallbackPhone: string,
  at: string,
): readonly Contact[] {
  if (contacts.length > 0) return contacts;
  return [
    {
      id: CONFIGURED_CONTACT_ID,
      name: "the configured responder",
      phone: fallbackPhone,
      createdAt: at,
    },
  ];
}

/** The next person after a position, or null when the rotation has run out of people. */
export function nextInRotation(
  rotation: readonly Contact[],
  position: number,
): Contact | null {
  return rotation[position + 1] ?? null;
}

/** Who a given position names, falling back to the head of the rotation if it has shrunk. */
export function contactAt(
  rotation: readonly Contact[],
  position: number,
): Contact | null {
  return rotation[position] ?? rotation[0] ?? null;
}
