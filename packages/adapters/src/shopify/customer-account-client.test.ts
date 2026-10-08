import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { CustomerOrderApiError } from "@nailzify/core";
import { createCustomerAccountClient } from "./customer-account-client.js";

const response = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("Shopify Customer Account API adapter", () => {
  it("exchanges a PKCE code and validates the signed Shopify identity token", async () => {
    const now = 1_800_000_000_000;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const idToken = signedToken(privateKey, {
      iss: "https://nailzify.com/account/customer",
      aud: "client-id",
      sub: "gid://shopify/Customer/12",
      nonce: "expected-nonce",
      iat: Math.floor(now / 1_000),
      exp: Math.floor(now / 1_000) + 300,
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        authorization_endpoint: "https://nailzify.com/account/authorize",
        token_endpoint: "https://nailzify.com/account/token",
        jwks_uri: "https://nailzify.com/account/jwks",
        issuer: "https://nailzify.com/account/customer",
      }))
      .mockResolvedValueOnce(response({
        access_token: "buyer-token",
        id_token: idToken,
        expires_in: 900,
      }))
      .mockResolvedValueOnce(response({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] }))
      .mockResolvedValueOnce(response({
        graphql_api: "https://shopify.com/customer/api/graphql",
      }))
      .mockResolvedValueOnce(response({
        data: { customer: { id: "gid://shopify/Customer/12" } },
      }));
    const client = createCustomerAccountClient({
      storefrontDomain: "nailzify.com",
      shopDomain: "dgjv8c-aa.myshopify.com",
      clientId: "client-id",
      javascriptOrigin: "https://www.nailzify.com",
      fetchImpl,
      now: () => now,
    });

    const grant = await client.exchangeAuthorizationCode({
      code: "one-time-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://edge.example.com/api/customer-orders/auth/callback",
    });
    expect(grant).toEqual({
      accessToken: "buyer-token",
      customerId: "gid://shopify/Customer/12",
      nonce: "expected-nonce",
      expiresInSeconds: 900,
    });
    expect(fetchImpl.mock.calls[1]![1]?.headers).toMatchObject({
      Origin: "https://www.nailzify.com",
    });
    expect(String(fetchImpl.mock.calls[1]![1]?.body)).toContain("code_verifier=pkce-verifier");
    expect(fetchImpl.mock.calls[4]![1]?.headers).toMatchObject({ Authorization: "buyer-token" });
    expect(String(fetchImpl.mock.calls[4]![1]?.body)).toContain("CustomerIdentity");
  });

  it("requests only minimized recent order fields and clamps the result request to five", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        graphql_api: "https://shopify.com/customer/api/graphql",
      }))
      .mockResolvedValueOnce(response({
        data: {
          customer: {
            id: "gid://shopify/Customer/12",
            orders: {
              nodes: [{
                id: "gid://shopify/Order/91",
                name: "#1091",
                createdAt: "2026-10-01T12:00:00Z",
                totalPrice: { amount: "39.00", currencyCode: "USD" },
                financialStatus: "PAID",
                fulfillmentStatus: "FULFILLED",
              }],
            },
          },
        },
      }));
    const client = createCustomerAccountClient({
      storefrontDomain: "nailzify.com",
      shopDomain: "dgjv8c-aa.myshopify.com",
      clientId: "client-id",
      javascriptOrigin: "https://www.nailzify.com",
      fetchImpl,
    });

    const result = await client.listRecentOrders("buyer-token", 99);
    expect(result.orders).toHaveLength(1);
    const request = fetchImpl.mock.calls[1]!;
    const body = JSON.parse(String(request[1]?.body)) as { query: string; variables: { first: number } };
    expect(body.variables.first).toBe(5);
    expect(body.query).toContain("totalPrice");
    expect(body.query).not.toMatch(/shippingAddress|billingAddress|email|phone|note|payment/i);
    expect(request[1]?.headers).toMatchObject({ Authorization: "buyer-token" });
  });

  it("keeps only a safe OAuth error code when Shopify rejects a token exchange", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        authorization_endpoint: "https://nailzify.com/account/authorize",
        token_endpoint: "https://account.nailzify.com/authentication/oauth/token",
        jwks_uri: "https://account.nailzify.com/authentication/jwks",
        issuer: "https://shopify.com/authentication/1",
      }))
      .mockResolvedValueOnce(response(
        { error: "invalid_grant", error_description: "sensitive provider detail" },
        400,
      ));
    const client = createCustomerAccountClient({
      storefrontDomain: "nailzify.com",
      shopDomain: "dgjv8c-aa.myshopify.com",
      clientId: "client-id",
      javascriptOrigin: "https://www.nailzify.com",
      fetchImpl,
    });

    await expect(client.exchangeAuthorizationCode({
      code: "one-time-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://edge.example.com/callback",
    })).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Shopify returned HTTP 400 (invalid_grant)",
    });
  });

  it("reports only a safe GraphQL authentication category", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        graphql_api: "https://shopify.com/customer/api/graphql",
      }))
      .mockResolvedValueOnce(response({
        errors: [{
          message: "sensitive provider detail",
          extensions: { code: "ACCESS_DENIED" },
        }],
      }));
    const client = createCustomerAccountClient({
      storefrontDomain: "nailzify.com",
      shopDomain: "dgjv8c-aa.myshopify.com",
      clientId: "client-id",
      javascriptOrigin: "https://www.nailzify.com",
      fetchImpl,
    });

    await expect(client.listRecentOrders("buyer-token", 5)).rejects.toMatchObject({
      kind: "authentication",
      message: "Shopify rejected the customer token (graphql_access_denied)",
    });
  });

  it("drops unsafe tracking links while preserving carrier and number", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        graphql_api: "https://shopify.com/customer/api/graphql",
      }))
      .mockResolvedValueOnce(response({
        data: {
          customer: {
            orders: {
              nodes: [{
                id: "gid://shopify/Order/91",
                name: "#1091",
                createdAt: "2026-10-01T12:00:00Z",
                totalPrice: { amount: "39.00", currencyCode: "USD" },
                financialStatus: "PAID",
                fulfillmentStatus: "FULFILLED",
                lineItems: { nodes: [{ name: "Rose Set", quantity: 1 }] },
                fulfillments: {
                  nodes: [{
                    trackingInformation: [{
                      company: "Carrier",
                      number: "TRACK123",
                      url: "javascript:alert(1)",
                    }],
                  }],
                },
              }],
            },
          },
        },
      }));
    const client = createCustomerAccountClient({
      storefrontDomain: "nailzify.com",
      shopDomain: "dgjv8c-aa.myshopify.com",
      clientId: "client-id",
      javascriptOrigin: "https://www.nailzify.com",
      fetchImpl,
    });

    const order = await client.getOrder("buyer-token", "gid://shopify/Order/91");
    expect(order?.tracking).toEqual([{ company: "Carrier", number: "TRACK123", url: null }]);
  });

  it("rejects an untrusted discovery host before sending customer credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ graphql_api: "https://attacker.example/graphql" }));
    const client = createCustomerAccountClient({
      storefrontDomain: "nailzify.com",
      shopDomain: "dgjv8c-aa.myshopify.com",
      clientId: "client-id",
      javascriptOrigin: "https://www.nailzify.com",
      fetchImpl,
    });

    await expect(client.listRecentOrders("buyer-token", 5)).rejects.toMatchObject({
      kind: "invalid_response",
    } satisfies Partial<CustomerOrderApiError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function signedToken(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}
