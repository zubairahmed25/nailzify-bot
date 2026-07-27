/**
 * The Session aggregate.
 *
 * "Aggregate" here just means: the object that owns a consistency boundary. Rules
 * about a conversation as a whole — how many turns it may take, how many tokens
 * it may spend, whether it has been handed to a human — live here rather than
 * being scattered across handlers.
 *
 * WHY BUDGETS EXIST AT ALL. This is not tidiness, it is a cost control. A single
 * looping or adversarial conversation calling a metered LLM is a financial
 * incident (docs/02-aws-services.md §2.3, "denial of wallet"). WAF stops volume;
 * this stops one client from being individually expensive.
 */

import { err, ok, type Result } from "../shared/result.js";
import {
  SessionEscalated,
  TokenBudgetExceeded,
  TurnBudgetExceeded,
} from "../shared/errors.js";
import type { CustomerId, SessionId } from "../shared/brand.js";

export interface SessionLimits {
  readonly maxTurns: number;
  readonly maxTokens: number;
}

/**
 * Defaults sized so a genuinely engaged customer never hits them, while a runaway
 * loop is capped. 50 turns is a very long conversation; 200k tokens is roughly
 * $1–2 of Sonnet at current pricing — an acceptable worst case for one session.
 */
export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxTurns: 50,
  maxTokens: 200_000,
};

export interface Session {
  readonly id: SessionId;
  /** Null when the shopper is not signed in. Most sessions, in practice. */
  readonly customerId: CustomerId | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly turnCount: number;
  readonly tokensUsed: number;
  /**
   * Rolling summary of turns older than the verbatim window.
   *
   * This is what keeps prompt size — and therefore per-conversation cost —
   * bounded instead of growing quadratically with turn count. See window.ts.
   */
  readonly summary: string | null;
  readonly escalated: boolean;
  /**
   * Optimistic-concurrency token. Two tabs posting at once would otherwise
   * interleave turns into nonsense; the repository writes conditionally on this.
   */
  readonly version: number;
}

export function createSession(
  id: SessionId,
  customerId: CustomerId | null,
  now: number,
): Session {
  return {
    id,
    customerId,
    createdAt: now,
    lastActiveAt: now,
    turnCount: 0,
    tokensUsed: 0,
    summary: null,
    escalated: false,
    version: 0,
  };
}

export type SessionRuleViolation =
  | TurnBudgetExceeded
  | TokenBudgetExceeded
  | SessionEscalated;

/**
 * May this session accept another turn?
 *
 * Returns a Result rather than throwing because every failure here is something
 * the caller must *handle* — each maps to a specific, friendly customer-facing
 * message. These are expected outcomes, not bugs.
 */
export function canAcceptTurn(
  session: Session,
  limits: SessionLimits = DEFAULT_SESSION_LIMITS,
): Result<void, SessionRuleViolation> {
  // Escalation first: once a human owns the conversation, the bot must stop,
  // regardless of remaining budget. Ordering encodes precedence.
  if (session.escalated) return err(new SessionEscalated());

  if (session.turnCount >= limits.maxTurns) {
    return err(new TurnBudgetExceeded(session.turnCount, limits.maxTurns));
  }

  if (session.tokensUsed >= limits.maxTokens) {
    return err(new TokenBudgetExceeded(session.tokensUsed, limits.maxTokens));
  }

  return ok(undefined);
}

/**
 * Record a completed turn.
 *
 * Returns a NEW session rather than mutating. Immutability is not dogma here —
 * it means a caller cannot half-apply an update and leave the aggregate in a
 * state that never legitimately exists, and it makes the optimistic-concurrency
 * version bump impossible to forget.
 */
export function recordTurn(session: Session, tokensSpent: number, now: number): Session {
  return {
    ...session,
    turnCount: session.turnCount + 1,
    tokensUsed: session.tokensUsed + tokensSpent,
    lastActiveAt: now,
    version: session.version + 1,
  };
}

export function withSummary(session: Session, summary: string): Session {
  return { ...session, summary, version: session.version + 1 };
}

/** Mark as handed off. Terminal for the bot — `canAcceptTurn` will refuse after this. */
export function escalate(session: Session, now: number): Session {
  return { ...session, escalated: true, lastActiveAt: now, version: session.version + 1 };
}

/** Epoch SECONDS for the DynamoDB TTL attribute (note: not milliseconds). */
export function ttlFor(session: Session, retentionDays = 30): number {
  return Math.floor(session.lastActiveAt / 1000) + retentionDays * 24 * 60 * 60;
}
