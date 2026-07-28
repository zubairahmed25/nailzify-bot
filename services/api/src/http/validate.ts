/**
 * Request validation.
 *
 * WHY HAND-ROLLED AND NOT ZOD: this validates three fields. Zod is excellent and
 * I would reach for it the moment schemas get non-trivial, but it is ~14KB
 * gzipped in a bundle whose cold start is customer-facing latency. Forty lines
 * with no dependency is the better trade here — and revisiting it when the
 * schema grows is a five-minute change.
 *
 * WHAT VALIDATION IS FOR HERE: cheap rejection before expensive work. Every
 * millisecond and every token spent on a request we were going to reject is
 * waste, so these checks run before anything touches Bedrock.
 */

export interface ChatRequestBody {
  readonly sessionId: string;
  readonly messageId: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: ChatRequestBody }
  | { readonly ok: false; readonly reason: string };

/**
 * Upper bound on a single customer message.
 *
 * Not a UX limit — a cost control. Input is billed per token, and an
 * unbounded field lets one request submit a novel. ~2000 characters is roughly
 * 500 tokens, far more than any real storefront question.
 */
export const MAX_MESSAGE_LENGTH = 2000;

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function validateChatRequest(raw: string | null | undefined): ValidationResult {
  if (!raw) return { ok: false, reason: "empty body" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "body must be a JSON object" };
  }

  const body = parsed as Record<string, unknown>;

  const sessionId = body["sessionId"];
  const messageId = body["messageId"];
  const message = body["message"];

  // IDs are client-generated, so they are untrusted input that lands in a
  // DynamoDB partition key. Constraining the character set keeps a hostile
  // value from becoming a weird key or a log-injection vector.
  if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) {
    return { ok: false, reason: "sessionId must be 8-64 chars of [A-Za-z0-9_-]" };
  }
  if (typeof messageId !== "string" || !ID_PATTERN.test(messageId)) {
    return { ok: false, reason: "messageId must be 8-64 chars of [A-Za-z0-9_-]" };
  }
  if (typeof message !== "string") {
    return { ok: false, reason: "message must be a string" };
  }

  const trimmed = message.trim();
  if (trimmed.length === 0) return { ok: false, reason: "message is empty" };
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: `message exceeds ${MAX_MESSAGE_LENGTH} characters` };
  }

  return { ok: true, value: { sessionId, messageId, message: trimmed } };
}
