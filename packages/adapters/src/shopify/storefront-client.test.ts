import { describe, expect, it } from "vitest";
import { createStorefrontClient } from "./storefront-client.js";

// ⚠️ DELIBERATELY NOT SHAPED LIKE REAL CREDENTIALS. A fabricated
// "shpat_" + 32 hex string matched GitHub's Shopify-token scanner and blocked
// the push — correctly, since a scanner cannot tell a fake from a live one.
// These exercise the same branches (`startsWith("shpat_")`, 32-hex) without
// tripping it.
const PUBLIC_TOKEN = "0123456789abcdef0123456789abcdef";
const PRIVATE_TOKEN = "shpat_EXAMPLE_NOT_A_REAL_TOKEN";

function clientWith(
  accessToken: string,
  opts: { tokenKind?: "public" | "private"; status?: number } = {},
) {
  return createStorefrontClient({
    shopDomain: "nailzify.myshopify.com",
    accessToken,
    apiVersion: "2025-10",
    ...(opts.tokenKind ? { tokenKind: opts.tokenKind } : {}),
    fetchImpl: (async () =>
      new Response("Forbidden", { status: opts.status ?? 403 })) as unknown as typeof fetch,
  });
}

const failure = async (client: ReturnType<typeof clientWith>): Promise<Error> =>
  client.request("{ shop { name } }").then(
    () => {
      throw new Error("expected the request to fail");
    },
    (e: unknown) => e as Error,
  );

describe("auth failures explain themselves", () => {
  it("names the mismatch when a public token is sent as private", async () => {
    // THE DEPLOYED FAILURE. The public storefront token was stored in Secrets
    // Manager while the client defaults to the private header. Shopify returns a
    // bare 403, indistinguishable from a revoked credential — which is exactly
    // how an hour gets spent on the wrong hypothesis.
    const error = await failure(clientWith(PUBLIC_TOKEN));

    expect(error.message).toMatch(/PUBLIC storefront token format/);
    expect(error.message).toMatch(/shpat_/);
  });

  it("names the mismatch the other way round", async () => {
    const error = await failure(clientWith(PRIVATE_TOKEN, { tokenKind: "public" }));

    expect(error.message).toMatch(/public-token header/);
  });

  it("falls back to a scope hint when the shape looks right", async () => {
    // Shape is not evidence of validity — the token may simply lack the scope,
    // and scope changes need a reinstall to take effect.
    const error = await failure(clientWith(PRIVATE_TOKEN));

    expect(error.message).toMatch(/unauthenticated_read_product_listings/);
  });

  it("adds nothing to a non-auth failure", async () => {
    // 430 is Shopify throttling the shop. A token hint there would be noise
    // pointing at the wrong cause.
    const error = await failure(clientWith(PUBLIC_TOKEN, { status: 430 }));

    // The response body still gets folded in — that is the cause-surfacing
    // behaviour and it is wanted everywhere. What must NOT appear is a token
    // hint, which would point at the wrong cause entirely.
    expect(error.message).toContain("HTTP 430");
    expect(error.message).not.toMatch(/token|scope|shpat_/i);
  });

  it("never puts the token itself in the message", async () => {
    // These errors land in CloudWatch. A credential in one log line is a
    // credential in every downstream sink that log reaches.
    for (const token of [PUBLIC_TOKEN, PRIVATE_TOKEN]) {
      const error = await failure(clientWith(token));
      expect(error.message).not.toContain(token);
    }
  });
});

describe("shape checks are hints, never preconditions", () => {
  it("sends a shpat_ token without complaint", async () => {
    // ⚠️ REGRESSION GUARD. An earlier version REFUSED tokens starting with
    // "shpat_", believing the prefix meant Admin API. It does not — delegate and
    // custom-app Storefront tokens share it — and the check blocked a valid
    // token that was working fine via curl. Shape guesses; Shopify knows.
    const sent: Record<string, string> = {};
    const client = createStorefrontClient({
      shopDomain: "nailzify.myshopify.com",
      accessToken: PRIVATE_TOKEN,
      apiVersion: "2025-10",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        Object.assign(sent, init.headers);
        return new Response(JSON.stringify({ data: { shop: { name: "Nailzify" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await expect(client.request("{ shop { name } }")).resolves.toBeDefined();
    expect(sent["Shopify-Storefront-Private-Token"]).toBe(PRIVATE_TOKEN);
  });

  it("uses the public header only when asked", async () => {
    const sent: Record<string, string> = {};
    const client = createStorefrontClient({
      shopDomain: "nailzify.myshopify.com",
      accessToken: PUBLIC_TOKEN,
      apiVersion: "2025-10",
      tokenKind: "public",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        Object.assign(sent, init.headers);
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await client.request("{ shop { name } }");

    expect(sent["X-Shopify-Storefront-Access-Token"]).toBe(PUBLIC_TOKEN);
    expect(sent["Shopify-Storefront-Private-Token"]).toBeUndefined();
  });
});
