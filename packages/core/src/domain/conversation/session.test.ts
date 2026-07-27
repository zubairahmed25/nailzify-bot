import { describe, expect, it } from "vitest";
import { CustomerId, SessionId } from "../shared/brand.js";
import { SessionEscalated, TokenBudgetExceeded, TurnBudgetExceeded } from "../shared/errors.js";
import {
  canAcceptTurn,
  createSession,
  escalate,
  recordTurn,
  ttlFor,
  withSummary,
} from "./session.js";

const NOW = 1_700_000_000_000;
const session = () => createSession(SessionId("s1"), CustomerId("c1"), NOW);

describe("session budgets", () => {
  it("accepts a turn on a fresh session", () => {
    expect(canAcceptTurn(session()).ok).toBe(true);
  });

  it("refuses once the turn budget is spent", () => {
    // Cost guardrail: one looping client must not be individually expensive.
    const exhausted = { ...session(), turnCount: 50 };
    const result = canAcceptTurn(exhausted, { maxTurns: 50, maxTokens: 200_000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(TurnBudgetExceeded);
  });

  it("refuses once the token budget is spent", () => {
    const exhausted = { ...session(), tokensUsed: 200_000 };
    const result = canAcceptTurn(exhausted, { maxTurns: 50, maxTokens: 200_000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(TokenBudgetExceeded);
  });

  it("refuses after escalation regardless of remaining budget", () => {
    // Ordering encodes precedence: once a human owns the conversation, the bot
    // stops even though it has plenty of turns left.
    const handed = escalate(session(), NOW);
    const result = canAcceptTurn(handed);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(SessionEscalated);
  });
});

describe("session updates are immutable", () => {
  it("returns a new session rather than mutating", () => {
    const original = session();
    const updated = recordTurn(original, 1_200, NOW + 5_000);

    expect(original.turnCount).toBe(0);
    expect(updated.turnCount).toBe(1);
    expect(updated).not.toBe(original);
  });

  it("bumps the version on every mutation", () => {
    // The version drives the conditional write that stops two browser tabs from
    // interleaving turns. Forgetting to bump it would silently disable that.
    const s0 = session();
    const s1 = recordTurn(s0, 100, NOW);
    const s2 = withSummary(s1, "summary");
    const s3 = escalate(s2, NOW);

    expect([s0.version, s1.version, s2.version, s3.version]).toEqual([0, 1, 2, 3]);
  });

  it("accumulates token spend across turns", () => {
    let s = session();
    s = recordTurn(s, 1_000, NOW);
    s = recordTurn(s, 2_500, NOW + 1000);

    expect(s.tokensUsed).toBe(3_500);
    expect(s.turnCount).toBe(2);
  });

  it("advances lastActiveAt", () => {
    const updated = recordTurn(session(), 100, NOW + 60_000);
    expect(updated.lastActiveAt).toBe(NOW + 60_000);
  });
});

describe("ttl", () => {
  it("returns epoch SECONDS, not milliseconds", () => {
    // DynamoDB TTL expects seconds. Passing milliseconds sets expiry ~50,000
    // years out and silently disables the retention policy.
    const ttl = ttlFor(session(), 30);
    const expected = Math.floor(NOW / 1000) + 30 * 24 * 60 * 60;

    expect(ttl).toBe(expected);
    expect(ttl).toBeLessThan(NOW); // sanity: seconds are ~1000x smaller
  });

  it("measures retention from last activity, not creation", () => {
    const active = recordTurn(session(), 100, NOW + 10 * 24 * 60 * 60 * 1000);
    expect(ttlFor(active, 30)).toBeGreaterThan(ttlFor(session(), 30));
  });
});

describe("anonymous sessions", () => {
  it("supports a null customerId", () => {
    // Most storefront visitors are not signed in. This is the common path.
    const anon = createSession(SessionId("s2"), null, NOW);
    expect(anon.customerId).toBeNull();
    expect(canAcceptTurn(anon).ok).toBe(true);
  });
});
