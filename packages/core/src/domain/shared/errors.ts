/**
 * Domain errors.
 *
 * WHY A SEPARATE HIERARCHY: notice there is not a single HTTP status code in
 * this file. The domain does not know it is being served over HTTP — it might be
 * a Lambda today, a queue consumer tomorrow, a CLI in a test. Mapping
 * `TurnBudgetExceeded` to `429` is the *transport* layer's job
 * (docs/07-backend.md §7.6).
 *
 * The moment a domain file imports a status code, the layering has leaked and
 * the domain is no longer reusable.
 */

/** Base for rule violations: the request was understood and is not allowed. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Without this, `instanceof` breaks for subclasses when targeting ES5-ish
    // output, and the stack trace shows "Error" instead of the real class name.
    this.name = new.target.name;
  }
}

/** Base for "the outside world failed us": a dependency is unavailable or broke. */
export abstract class InfrastructureError extends Error {
  abstract readonly code: string;
  /** Whether a retry could plausibly succeed. Drives backoff decisions upstream. */
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    // ⚠️ `cause` ALONE IS NOT ENOUGH, AND BELIEVING IT WAS COST A DEPLOY CYCLE.
    //
    // Passing `cause` to super() is correct and preserves it in-process. It does
    // NOT survive AWS Lambda's error serialization: Lambda emits errorType,
    // errorMessage, and stack, plus own ENUMERABLE properties. `cause` is
    // non-enumerable, so CloudWatch showed only:
    //
    //     {"errorType":"$d","errorMessage":"Pinecone upsert failed"}
    //
    // — a wrapper message with the actual reason stripped out, from a minified
    // bundle where even the class name is mangled. Undiagnosable.
    //
    // So the cause is folded into the message itself, which survives every
    // serializer, and exposed as an enumerable field for structured log queries.
    super(joinCause(message, options?.cause), options);
    this.name = new.target.name;
    this.causeMessage = describeCause(options?.cause);
  }

  /** Enumerable, unlike `cause` — this is what reaches CloudWatch. */
  readonly causeMessage: string | null;
}

/** Longest cause text folded into a message. Enough to identify, not to flood. */
const MAX_CAUSE_LENGTH = 300;

function describeCause(cause: unknown): string | null {
  if (cause === undefined || cause === null) return null;
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_CAUSE_LENGTH
    ? `${trimmed.slice(0, MAX_CAUSE_LENGTH)}… (truncated)`
    : trimmed;
}

function joinCause(message: string, cause: unknown): string {
  const detail = describeCause(cause);
  // Skip when the cause adds nothing — a wrapper that already quotes it, or a
  // cause whose message IS the wrapper message.
  if (!detail || message.includes(detail)) return message;
  return `${message}: ${detail}`;
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/** One conversation has exceeded its allowed number of turns. Cost guardrail. */
export class TurnBudgetExceeded extends DomainError {
  readonly code = "TURN_BUDGET_EXCEEDED";
  constructor(
    readonly turnCount: number,
    readonly limit: number,
  ) {
    super(`Conversation reached its ${limit}-turn limit (currently ${turnCount}).`);
  }
}

/** One conversation has burned through its token allowance. Cost guardrail. */
export class TokenBudgetExceeded extends DomainError {
  readonly code = "TOKEN_BUDGET_EXCEEDED";
  constructor(
    readonly tokensUsed: number,
    readonly limit: number,
  ) {
    super(`Conversation used ${tokensUsed} tokens, over its ${limit} limit.`);
  }
}

/** The agent loop hit its hop ceiling. Prevents an unbounded (expensive) loop. */
export class ToolHopLimitExceeded extends DomainError {
  readonly code = "TOOL_HOP_LIMIT_EXCEEDED";
  constructor(readonly limit: number) {
    super(`Agent exceeded ${limit} tool hops without reaching an answer.`);
  }
}

/** This conversation was handed to a human; the bot should stop responding. */
export class SessionEscalated extends DomainError {
  readonly code = "SESSION_ESCALATED";
  constructor() {
    super("This conversation has been escalated to a human agent.");
  }
}

// ---------------------------------------------------------------------------
// Infrastructure errors
// ---------------------------------------------------------------------------

export class VectorStoreUnavailable extends InfrastructureError {
  readonly code = "VECTOR_STORE_UNAVAILABLE";
  readonly retryable = true;
}

export class CatalogUnavailable extends InfrastructureError {
  readonly code = "CATALOG_UNAVAILABLE";
  readonly retryable = true;
}

export class LlmUnavailable extends InfrastructureError {
  readonly code = "LLM_UNAVAILABLE";
  readonly retryable = true;
}

export class LlmThrottled extends InfrastructureError {
  readonly code = "LLM_THROTTLED";
  readonly retryable = true;
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A stored record did not match the shape we expect. Not retryable — it's a bug. */
export class RepositoryCorruption extends InfrastructureError {
  readonly code = "REPOSITORY_CORRUPTION";
  readonly retryable = false;
}
