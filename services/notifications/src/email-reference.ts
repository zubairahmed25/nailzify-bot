import { createHmac, timingSafeEqual } from "node:crypto";

export interface EmailReference {
  readonly ticketId: string;
  readonly eventId: string;
  readonly recipientType: "customer" | "merchant";
  readonly commentId?: string;
  readonly commentCreatedAt?: number;
}

export function makeEmailReference(reference: EmailReference, secret: string): string {
  const payload = Buffer.from(JSON.stringify(reference)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyEmailReference(value: string, secret: string): EmailReference | null {
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra) return null;
  const expected = signature(payload, secret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<EmailReference>;
    if (!parsed.ticketId || !parsed.eventId) return null;
    if (parsed.recipientType !== "customer" && parsed.recipientType !== "merchant") return null;
    if (parsed.commentId !== undefined && typeof parsed.commentId !== "string") return null;
    if (parsed.commentCreatedAt !== undefined && !Number.isFinite(parsed.commentCreatedAt)) return null;
    return parsed as EmailReference;
  } catch {
    return null;
  }
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`ticket-email:${payload}`).digest("base64url");
}
