import { createHmac, timingSafeEqual } from "node:crypto";

export function makeReplyToken(ticketId: string, secret: string): string {
  const encoded = Buffer.from(ticketId, "utf8").toString("base64url");
  // A 128-bit authenticator keeps the reply address within the 64-byte local-part limit.
  const signature = createHmac("sha256", secret).update(`ticket-reply:v1:${encoded}`).digest().subarray(0, 16).toString("base64url");
  return `v1.${encoded}.${signature}`;
}

export function verifyReplyToken(token: string, secret: string): string | null {
  const compact = token.startsWith("v1.");
  const [encoded, provided, extra] = (compact ? token.slice(3) : token).split(".");
  if (!encoded || !provided || extra !== undefined) return null;
  const digest = createHmac("sha256", secret).update(`ticket-reply:${compact ? "v1:" : ""}${encoded}`).digest();
  const expected = (compact ? digest.subarray(0, 16) : digest).toString("base64url");
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const ticketId = Buffer.from(encoded, "base64url").toString("utf8");
    return ticketId.startsWith("TKT-") ? ticketId : null;
  } catch {
    return null;
  }
}
