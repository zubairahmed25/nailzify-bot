import { createHmac, timingSafeEqual } from "node:crypto";

export function makeReplyToken(ticketId: string, secret: string): string {
  const encoded = Buffer.from(ticketId, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`ticket-reply:${encoded}`).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyReplyToken(token: string, secret: string): string | null {
  const [encoded, provided, extra] = token.split(".");
  if (!encoded || !provided || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(`ticket-reply:${encoded}`).digest("base64url");
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
