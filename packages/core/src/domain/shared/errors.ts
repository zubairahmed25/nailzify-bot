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
    // ALWAYS pass `cause` through. Losing the original stack when wrapping an
    // error is the single most common reason production debugging gets hard.
    super(message, options);
    this.name = new.target.name;
  }
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
