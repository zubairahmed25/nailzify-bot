import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { computeSignature, verifyAppProxyRequest } from "./verify-app-proxy.js";

const SECRET = "shpss_test_secret_value";

const signed = (
  params: Record<string, string | string[]>,
): Record<string, string | string[]> => ({
  ...params,
  signature: computeSignature(params, SECRET),
});

describe("the signing algorithm", () => {
  // ⚠️ These pin the algorithm as implemented. They prove SELF-CONSISTENCY, not
  // agreement with Shopify — the authoritative check is one real App Proxy
  // request. If that fails, this describe block is where to look.
  it("sorts keys lexicographically and joins pairs with no separator", () => {
    const params = { shop: "nailzify.myshopify.com", path_prefix: "/apps/chat", timestamp: "1700000000" };

    // Hand-computed to the documented recipe: sorted keys, `key=value`,
    // concatenated with nothing between them.
    //
    // Lexicographic order is path_prefix < shop < timestamp. Getting this wrong
    // produces a valid-looking hex digest that rejects every real request — the
    // failure mode is silent, which is exactly why it is pinned here.
    const expected = createHmac("sha256", SECRET)
      .update("path_prefix=/apps/chatshop=nailzify.myshopify.comtimestamp=1700000000", "utf8")
      .digest("hex");

    expect(computeSignature(params, SECRET)).toBe(expected);
  });

  it("joins repeated parameters with a comma", () => {
    const expected = createHmac("sha256", SECRET).update("ids=1,2,3", "utf8").digest("hex");

    expect(computeSignature({ ids: ["1", "2", "3"] }, SECRET)).toBe(expected);
  });

  it("excludes the signature parameter from its own input", () => {
    const params = { shop: "x" };
    const withSignature = { ...params, signature: "whatever" };

    expect(computeSignature(withSignature, SECRET)).toBe(computeSignature(params, SECRET));
  });

  it("emits lowercase hex, not base64", () => {
    // Webhooks use base64 in a header; App Proxy uses hex in a query param.
    // Using the webhook recipe here silently rejects every request.
    expect(computeSignature({ shop: "x" }, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verification", () => {
  it("accepts a correctly signed request", () => {
    const result = verifyAppProxyRequest(
      signed({ shop: "nailzify.myshopify.com", path_prefix: "/apps/chat" }),
      SECRET,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.shop).toBe("nailzify.myshopify.com");
  });

  it("rejects a tampered parameter", () => {
    // THE ATTACK THIS EXISTS FOR: forging a request to a metered LLM endpoint.
    const request = signed({ shop: "nailzify.myshopify.com" });
    const tampered = { ...request, shop: "attacker.myshopify.com" };

    expect(verifyAppProxyRequest(tampered, SECRET).ok).toBe(false);
  });

  it("rejects an added parameter", () => {
    const request = signed({ shop: "nailzify.myshopify.com" });

    expect(verifyAppProxyRequest({ ...request, extra: "1" }, SECRET).ok).toBe(false);
  });

  it("rejects a removed parameter", () => {
    const request = signed({ shop: "x", path_prefix: "/apps/chat" });
    const stripped = { shop: request["shop"]!, signature: request["signature"]! };

    expect(verifyAppProxyRequest(stripped, SECRET).ok).toBe(false);
  });

  it("rejects a signature from a different secret", () => {
    const forged = { shop: "x", signature: computeSignature({ shop: "x" }, "wrong-secret") };

    expect(verifyAppProxyRequest(forged, SECRET).ok).toBe(false);
  });

  it("rejects a missing signature", () => {
    const result = verifyAppProxyRequest({ shop: "x" }, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing signature");
  });

  it("refuses to verify when no secret is configured", () => {
    // A misconfigured deployment must fail CLOSED. An empty secret that
    // "verified" would be an open LLM endpoint.
    const result = verifyAppProxyRequest(signed({ shop: "x" }), "");

    expect(result.ok).toBe(false);
  });

  it("does not throw on a length-mismatched signature", () => {
    // timingSafeEqual throws on unequal lengths; comparing lengths first must
    // not turn a hostile input into a 500.
    expect(() => verifyAppProxyRequest({ shop: "x", signature: "ab" }, SECRET)).not.toThrow();
    expect(verifyAppProxyRequest({ shop: "x", signature: "ab" }, SECRET).ok).toBe(false);
  });
});

describe("identity", () => {
  it("extracts the logged-in customer id", () => {
    // Trusted because it arrived under a verified signature — a browser-supplied
    // customer id would be worthless as an identity claim.
    const result = verifyAppProxyRequest(
      signed({ shop: "x", logged_in_customer_id: "gid://shopify/Customer/7712" }),
      SECRET,
    );

    expect(result.ok && result.customerId).toBe("gid://shopify/Customer/7712");
  });

  it("treats an anonymous shopper as null, not empty string", () => {
    // Shopify sends the parameter empty when signed out. Most sessions.
    const result = verifyAppProxyRequest(signed({ shop: "x", logged_in_customer_id: "" }), SECRET);

    expect(result.ok && result.customerId).toBeNull();
  });
});

describe("replay window", () => {
  const now = () => 1_700_000_300_000; // 1_700_000_300 seconds

  it("accepts a fresh request", () => {
    const request = signed({ shop: "x", timestamp: "1700000280" });

    expect(verifyAppProxyRequest(request, SECRET, { now, maxAgeSeconds: 300 }).ok).toBe(true);
  });

  it("rejects a stale one", () => {
    const request = signed({ shop: "x", timestamp: "1699999000" });
    const result = verifyAppProxyRequest(request, SECRET, { now, maxAgeSeconds: 300 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("stale");
  });

  it("rejects a future timestamp too", () => {
    // Clock skew cuts both ways; a far-future stamp is as suspicious as a stale one.
    const request = signed({ shop: "x", timestamp: "1700009999" });

    expect(verifyAppProxyRequest(request, SECRET, { now, maxAgeSeconds: 300 }).ok).toBe(false);
  });

  it("checks freshness only after the signature verifies", () => {
    // Otherwise an attacker could probe timestamp handling without a valid
    // signature, learning about the window for free.
    const result = verifyAppProxyRequest(
      { shop: "x", timestamp: "1", signature: "deadbeef" },
      SECRET,
      { now },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });
});
