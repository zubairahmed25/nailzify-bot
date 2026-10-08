import { describe, expect, it, vi } from "vitest";
import {
  CustomerId,
  CustomerOrderApiError,
  SessionId,
  type CustomerOrderAccess,
  type CustomerOrderAuditEvent,
  type CustomerOrderAuthChallenge,
  type CustomerOrderAuthRepository,
  type CustomerOrderSession,
  type SecretCipher,
} from "@nailzify/core";
import { createCustomerOrderService, CustomerOrderServiceError } from "./service.js";

const SHOP = "dgjv8c-aa.myshopify.com";
const SESSION = SessionId("01JQZ8K2M4ABCDEF");
const CUSTOMER = CustomerId("gid://shopify/Customer/123");

function fixture() {
  const challenges = new Map<string, CustomerOrderAuthChallenge>();
  const sessions = new Map<string, CustomerOrderSession>();
  const audits: CustomerOrderAuditEvent[] = [];
  const authFailures: Array<{ readonly stage: string; readonly category: string }> = [];
  let now = 1_800_000_000_000;
  let byte = 0;

  const repository: CustomerOrderAuthRepository = {
    async createChallenge(value) { challenges.set(value.stateHash, value); },
    async consumeChallenge(stateHash) {
      const value = challenges.get(stateHash) ?? null;
      challenges.delete(stateHash);
      return value;
    },
    async saveSession(value) { sessions.set(value.sessionId, value); },
    async loadSession(sessionId) { return sessions.get(sessionId) ?? null; },
    async deleteSession(sessionId) { sessions.delete(sessionId); },
    async appendAudit(event) { audits.push(event); },
    async consumeRateLimit() { return true; },
  };
  const cipher: SecretCipher = {
    async encrypt(value) { return `encrypted:${value}`; },
    async decrypt(value) {
      if (!value.startsWith("encrypted:")) throw new Error("invalid ciphertext");
      return value.slice("encrypted:".length);
    },
  };
  const access: CustomerOrderAccess = {
    createAuthorizationUrl: vi.fn(async (input) =>
      `https://account.nailzify.com/auth?state=${encodeURIComponent(input.state)}`),
    exchangeAuthorizationCode: vi.fn(async () => ({
      accessToken: "buyer-token",
      customerId: CUSTOMER,
      nonce: "unused",
      expiresInSeconds: 3_600,
    })),
    listRecentOrders: vi.fn(async () => ({ customerId: CUSTOMER, orders: [] })),
    getOrder: vi.fn(async () => null),
  };
  const sleep = vi.fn(async () => undefined);
  const service = createCustomerOrderService({
    shopDomain: SHOP,
    callbackUrl: "https://edge.example.com/api/customer-orders/auth/callback",
    allowedReturnOrigin: "https://nailzify.com",
    access,
    repository,
    cipher,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++byte),
    randomId: () => "audit-id",
    random: () => 0,
    sleep,
    onAuthFailure: (event) => authFailures.push(event),
  });

  const authorize = async () => {
    await service.beginAuthentication({
      shop: SHOP,
      sessionId: SESSION,
      returnUrl: "https://nailzify.com/products/example#chat",
    });
    const input = vi.mocked(access.createAuthorizationUrl).mock.calls[0]![0];
    vi.mocked(access.exchangeAuthorizationCode).mockResolvedValueOnce({
      accessToken: "buyer-token",
      customerId: CUSTOMER,
      nonce: input.nonce,
      expiresInSeconds: 3_600,
    });
    const redirect = await service.completeAuthentication({ state: input.state, code: "code" });
    return { input, redirect };
  };

  return {
    service,
    access,
    repository,
    sessions,
    challenges,
    audits,
    authFailures,
    sleep,
    authorize,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

describe("customer order service", () => {
  it("creates a one time PKCE challenge and stores only encrypted verifier material", async () => {
    const f = fixture();
    await f.service.beginAuthentication({
      shop: SHOP,
      sessionId: SESSION,
      returnUrl: "https://nailzify.com/products/example",
      sourceAddress: "203.0.113.4",
    });

    const auth = vi.mocked(f.access.createAuthorizationUrl).mock.calls[0]![0];
    const challenge = [...f.challenges.values()][0]!;
    expect(auth.state).toHaveLength(43);
    expect(auth.nonce).toHaveLength(43);
    expect(auth.codeChallenge).toHaveLength(43);
    expect(challenge.encryptedCodeVerifier).toMatch(/^encrypted:/);
    expect(JSON.stringify(challenge)).not.toContain(auth.state);
    expect(JSON.stringify(challenge)).not.toContain(auth.nonce);
  });

  it("rejects an open redirect before creating an authorization request", async () => {
    const f = fixture();
    await expect(f.service.beginAuthentication({
      shop: SHOP,
      sessionId: SESSION,
      returnUrl: "https://attacker.example/steal",
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(f.access.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("completes authentication once and binds the encrypted token to the chat session", async () => {
    const f = fixture();
    const { input, redirect } = await f.authorize();
    expect(redirect).toBe("https://nailzify.com/products/example?order_auth=success#chat");
    expect(f.sessions.get(SESSION)).toMatchObject({
      customerId: CUSTOMER,
      encryptedAccessToken: "encrypted:buyer-token",
    });

    const replay = await f.service.completeAuthentication({ state: input.state, code: "code-again" });
    expect(replay).toBe("https://nailzify.com/?order_auth=expired");
    expect(f.access.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("reports only the safe stage and category when authentication fails", async () => {
    const f = fixture();
    await f.service.beginAuthentication({
      shop: SHOP,
      sessionId: SESSION,
      returnUrl: "https://nailzify.com/products/example",
    });
    const input = vi.mocked(f.access.createAuthorizationUrl).mock.calls[0]![0];
    vi.mocked(f.access.exchangeAuthorizationCode).mockRejectedValueOnce(
      new CustomerOrderApiError("invalid_response", "Shopify returned HTTP 400 (invalid_grant)"),
    );

    const redirect = await f.service.completeAuthentication({ state: input.state, code: "code" });

    expect(redirect).toBe("https://nailzify.com/products/example?order_auth=failed");
    expect(f.authFailures).toEqual([{
      stage: "exchange_code",
      category: "invalid_response:http_400:invalid_grant",
    }]);
  });

  it("reports a safe identity token validation category without token data", async () => {
    const f = fixture();
    await f.service.beginAuthentication({
      shop: SHOP,
      sessionId: SESSION,
      returnUrl: "https://nailzify.com/products/example",
    });
    const input = vi.mocked(f.access.createAuthorizationUrl).mock.calls[0]![0];
    vi.mocked(f.access.exchangeAuthorizationCode).mockRejectedValueOnce(
      new CustomerOrderApiError("authentication", "Shopify identity token claims are invalid"),
    );

    const redirect = await f.service.completeAuthentication({ state: input.state, code: "code" });

    expect(redirect).toBe("https://nailzify.com/products/example?order_auth=failed");
    expect(f.authFailures).toEqual([{
      stage: "exchange_code",
      category: "authentication:claims_invalid",
    }]);
  });

  it("retries one transient Shopify failure and emits only privacy safe audit metadata", async () => {
    const f = fixture();
    await f.authorize();
    vi.mocked(f.access.listRecentOrders)
      .mockRejectedValueOnce(new CustomerOrderApiError("unavailable", "timeout"))
      .mockResolvedValueOnce({
        customerId: CUSTOMER,
        orders: [{
          id: "gid://shopify/Order/88",
          name: "#1088",
          createdAt: "2026-10-01T12:00:00Z",
          total: { amount: "29.00", currencyCode: "USD" },
          financialStatus: "PAID",
          fulfillmentStatus: "UNFULFILLED",
        }],
      });

    const orders = await f.service.listRecent({ shop: SHOP, sessionId: SESSION, customerId: "123" });
    expect(orders).toHaveLength(1);
    expect(f.access.listRecentOrders).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.audits).toHaveLength(1);
    expect(Object.keys(f.audits[0]!).sort()).toEqual([
      "createdAt",
      "customerReference",
      "id",
      "latencyMs",
      "operation",
      "result",
      "sessionId",
      "shop",
    ]);
    expect(JSON.stringify(f.audits[0])).not.toContain("#1088");
    expect(JSON.stringify(f.audits[0])).not.toContain("gid://shopify/Order/88");
  });

  it("fails closed and deletes the session when the signed in storefront customer changes", async () => {
    const f = fixture();
    await f.authorize();
    await expect(f.service.listRecent({
      shop: SHOP,
      sessionId: SESSION,
      customerId: "999",
    })).rejects.toBeInstanceOf(CustomerOrderServiceError);
    expect(f.sessions.has(SESSION)).toBe(false);
    expect(f.access.listRecentOrders).not.toHaveBeenCalled();
  });

  it("expires the server session and never calls Shopify", async () => {
    const f = fixture();
    await f.authorize();
    f.advance(16 * 60 * 1_000);
    await expect(f.service.listRecent({ shop: SHOP, sessionId: SESSION, customerId: null }))
      .rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(f.access.listRecentOrders).not.toHaveBeenCalled();
  });
});
