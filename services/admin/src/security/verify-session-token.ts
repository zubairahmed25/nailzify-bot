/**
 * Shopify session token verification — the embedded admin page's auth.
 *
 * ============================================================================
 * WHY THIS IS A DIFFERENT SCHEME FROM THE APP PROXY
 * ============================================================================
 *
 * services/api/src/security/verify-app-proxy.ts verifies a signed QUERY STRING,
 * because the App Proxy forwards a storefront request Shopify itself signs.
 * This is a different direction entirely: the embedded admin page runs Shopify
 * App Bridge in the merchant's browser, which mints a short-lived JSON Web
 * Token (a "session token") and attaches it as `Authorization: Bearer <token>`
 * on every request to this Lambda. Confusing the two schemes fails silently —
 * a webhook-style body HMAC here would reject every legitimate request.
 *
 * ============================================================================
 * THE SECRET IS THE SAME ONE — CONFIRMED, NOT ASSUMED
 * ============================================================================
 *
 * Session tokens are HS256-signed with the app's API secret key (Client
 * secret) — the identical credential already stored as `shopify-proxy-secret`
 * (infra/lib/data-stack.ts) for the App Proxy HMAC. One Shopify app has
 * exactly one Client secret; it signs both request shapes. No new secret was
 * provisioned for this file.
 *
 * Verified against Shopify's own reference implementation
 * (github.com/Shopify/shopify-app-js, decode-session-token.ts) and
 * shopify.dev/docs/apps/build/authentication-authorization/session-tokens —
 * both confirm: HS256, verified with the API secret key, `aud` checked against
 * the API key (Client ID), `exp`/`nbf` checked with a small clock-skew
 * allowance (Shopify's own library uses 10 seconds; matched here).
 *
 * ============================================================================
 * WHY HAND-ROLLED RATHER THAN A LIBRARY
 * ============================================================================
 *
 * Shopify's docs recommend `@shopify/shopify-api`, which brings in a session
 * storage abstraction, OAuth helpers and a REST/GraphQL client this project
 * has no use for — the App Proxy verification a few directories over already
 * established the pattern of hand-rolling the specific crypto operation needed
 * with `node:crypto` rather than adopting a large SDK for one check. A JWT
 * HS256 signature is exactly that: one HMAC-SHA256 and a constant-time
 * compare, identical in kind to the App Proxy file's `computeSignature`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Matches jose's default, and Shopify's own library's, clock-skew allowance. */
const CLOCK_TOLERANCE_SECONDS = 10;

export type SessionTokenResult =
  | { readonly ok: true; readonly shop: string; readonly userId: string }
  | { readonly ok: false; readonly reason: string };

export interface VerifySessionTokenOptions {
  readonly now?: () => number;
}

/**
 * Verify a session token from an `Authorization` header value.
 *
 * `shopDomain` is the ONE configured shop this deployment serves
 * (infra/bin/app.ts `shopDomain`) — this is a single-tenant app, so `dest` is
 * checked for equality rather than merely "looks like a myshopify.com domain".
 * A token minted for a different shop is rejected the same way a forged one
 * would be.
 */
export function verifySessionToken(
  authorizationHeader: string | undefined,
  secret: string,
  apiKey: string,
  shopDomain: string,
  options: VerifySessionTokenOptions = {},
): SessionTokenResult {
  if (!secret) return { ok: false, reason: "no session secret configured" };
  if (!apiKey) return { ok: false, reason: "no api key configured" };

  const token = extractBearerToken(authorizationHeader);
  if (!token) return { ok: false, reason: "missing bearer token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const expectedSignature = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`, "utf8")
    .digest("base64url");

  if (!constantTimeEquals(signaturePart, expectedSignature)) {
    return { ok: false, reason: "signature mismatch" };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, reason: "malformed payload" };
  }

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);

  const exp = num(payload["exp"]);
  if (exp === null || nowSeconds > exp + CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "token expired" };
  }

  const nbf = num(payload["nbf"]);
  if (nbf !== null && nowSeconds < nbf - CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "token not yet valid" };
  }

  if (payload["aud"] !== apiKey) {
    return { ok: false, reason: "audience mismatch" };
  }

  // `dest` is the shop the token was minted for, e.g. "https://shop.myshopify.com".
  const expectedDest = `https://${shopDomain}`;
  if (payload["dest"] !== expectedDest) {
    return { ok: false, reason: "shop mismatch" };
  }

  // `iss` is `<dest>/admin` by convention. Checked as defence in depth, same
  // spirit as layering WAF on top of the App Proxy HMAC (infra/lib/api-stack.ts)
  // — the dest check above is already load-bearing on its own.
  const iss = payload["iss"];
  if (typeof iss !== "string" || !iss.startsWith(expectedDest)) {
    return { ok: false, reason: "issuer mismatch" };
  }

  const sub = payload["sub"];
  if (typeof sub !== "string" || sub.length === 0) {
    return { ok: false, reason: "missing subject" };
  }

  return { ok: true, shop: shopDomain, userId: sub };
}

/**
 * Mints a validly-signed token. Real ones only ever come from Shopify App
 * Bridge — this exists purely so tests elsewhere in this service (handler.test.ts)
 * can construct one without duplicating the HS256/base64url mechanics, the
 * same role `computeSignature` plays in verify-app-proxy.ts.
 */
export function signSessionTokenForTest(
  claims: {
    readonly iss?: string;
    readonly dest?: string;
    readonly aud?: string;
    readonly sub?: string;
    readonly exp?: number;
    readonly nbf?: number;
  },
  secret: string,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`, "utf8")
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function base64url(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Same rationale and implementation as verify-app-proxy.ts's constantTimeEquals. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferB, bufferB);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
