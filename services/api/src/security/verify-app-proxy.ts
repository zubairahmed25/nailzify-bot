/**
 * Shopify App Proxy signature verification.
 *
 * ============================================================================
 * WHY THIS FILE IS THE FRONT DOOR
 * ============================================================================
 *
 * Our Lambda calls a metered LLM. An unauthenticated endpoint in front of one is
 * a FINANCIAL vulnerability, not merely a security one — sometimes called
 * "denial of wallet". WAF caps volume; this stops forgery. Both are needed:
 * WAF cannot tell a legitimate storefront request from a crafted one.
 *
 * Shopify signs every request it forwards through an App Proxy using the app's
 * API secret key. If the signature verifies, the request genuinely came through
 * the Nailzify storefront. If it does not, we reject before spending a token.
 *
 * ⚠️ THE SECRET HERE IS THE API SECRET KEY (Client secret) — not the Storefront
 * API access token. This system uses two Shopify credentials in opposite
 * directions (docs/05-chat-lifecycle.md §5.4):
 *
 *     API secret key            inbound   verifying this signature
 *     Storefront access token   outbound  hydrating live product data
 *
 * ============================================================================
 * ⚠️ VERIFICATION STATUS
 * ============================================================================
 *
 * The ALGORITHM below is written from knowledge, not confirmed against Shopify's
 * docs — three attempts to fetch the authoritative page failed. It matches the
 * long-standing App Proxy scheme, but on this project unverified assumptions
 * have been wrong four times.
 *
 * BEFORE GOING LIVE: send one real request through the App Proxy and confirm it
 * verifies. A signature check that wrongly rejects looks like a totally broken
 * bot; one that wrongly accepts is an open LLM endpoint. Neither fails quietly.
 *
 * Note this is NOT the same scheme as Shopify webhooks, which put a base64 HMAC
 * over the raw body in an `X-Shopify-Hmac-Sha256` header. App Proxy signs the
 * QUERY STRING and hex-encodes into a `signature` parameter. Using the webhook
 * recipe here silently rejects everything.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_PARAM = "signature";

export type VerificationResult =
  | { readonly ok: true; readonly shop: string; readonly customerId: string | null }
  | { readonly ok: false; readonly reason: string };

export interface VerifyOptions {
  /** Reject requests older than this. Blunts replay of a captured URL. */
  readonly maxAgeSeconds?: number;
  readonly now?: () => number;
}

/**
 * Verify an App Proxy request from its query parameters.
 *
 * The algorithm:
 *   1. remove `signature`
 *   2. sort the remaining keys lexicographically
 *   3. render each as `key=value`, joining repeated values with `,`
 *   4. concatenate the pairs with NO separator between them
 *   5. HMAC-SHA256 with the app's API secret key, hex encoded
 *   6. compare in constant time
 */
export function verifyAppProxyRequest(
  query: Readonly<Record<string, string | string[] | undefined>>,
  secret: string,
  options: VerifyOptions = {},
): VerificationResult {
  const provided = first(query[SIGNATURE_PARAM]);
  if (!provided) return { ok: false, reason: "missing signature" };
  if (!secret) return { ok: false, reason: "no proxy secret configured" };

  const expected = computeSignature(query, secret);

  if (!constantTimeEquals(provided, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }

  // Freshness is checked only AFTER the signature verifies. Checking it first
  // would let an attacker probe timestamp handling without a valid signature.
  const maxAge = options.maxAgeSeconds ?? 300;
  const timestamp = Number(first(query["timestamp"]) ?? Number.NaN);
  if (Number.isFinite(timestamp) && maxAge > 0) {
    const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - timestamp) > maxAge) {
      return { ok: false, reason: "stale request" };
    }
  }

  const shop = first(query["shop"]) ?? "";
  const customerId = first(query["logged_in_customer_id"]) || null;

  return { ok: true, shop, customerId };
}

/** Exposed so tests can construct a validly-signed request. */
export function computeSignature(
  query: Readonly<Record<string, string | string[] | undefined>>,
  secret: string,
): string {
  const message = Object.keys(query)
    .filter((key) => key !== SIGNATURE_PARAM && query[key] !== undefined)
    .sort()
    .map((key) => {
      const value = query[key]!;
      // Repeated params are joined with a comma, NOT repeated as separate pairs.
      return `${key}=${Array.isArray(value) ? value.join(",") : value}`;
    })
    // No separator between pairs. This is the detail most reimplementations get
    // wrong (an `&` here rejects every legitimate request).
    .join("");

  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/**
 * Constant-time string comparison.
 *
 * ⚠️ `a === b` short-circuits on the first differing byte, so response time
 * leaks how much of a guess was correct — enough to reconstruct a signature
 * byte by byte. This is a real, practical attack against HMAC verification and
 * the mitigation is one function call.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length,
 * so we compare lengths first and still run the digest to keep timing flat.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    // Compare b against itself so the work done is independent of the input.
    timingSafeEqual(bufferB, bufferB);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
