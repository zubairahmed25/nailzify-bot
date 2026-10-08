import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CustomerOrderApiError,
  CustomerId,
  SessionId,
  type CustomerOrderAccess,
  type CustomerOrderAuditResult,
  type CustomerOrderAuthRepository,
  type CustomerOrderDetail,
  type CustomerOrderSummary,
  type SecretCipher,
} from "@nailzify/core";

export type CustomerOrderErrorCode =
  | "authentication_required"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "invalid_request";

export class CustomerOrderServiceError extends Error {
  constructor(
    readonly code: CustomerOrderErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CustomerOrderServiceConfig {
  readonly shopDomain: string;
  readonly callbackUrl: string;
  readonly allowedReturnOrigin: string;
  readonly maxRecent?: number;
  readonly sessionMinutes?: number;
  readonly access: CustomerOrderAccess;
  readonly repository: CustomerOrderAuthRepository;
  readonly cipher: SecretCipher;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomId?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly onAuthFailure?: (event: {
    readonly stage: "decrypt_verifier" | "exchange_code" | "validate_nonce" | "encrypt_token" | "save_session";
    readonly category: string;
  }) => void;
}

export interface CustomerOrderService {
  beginAuthentication(input: {
    readonly shop: string;
    readonly sessionId: string;
    readonly returnUrl: string;
    readonly sourceAddress?: string;
  }): Promise<{ readonly authorizationUrl: string }>;
  completeAuthentication(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
  }): Promise<string>;
  listRecent(input: CustomerOrderRequest): Promise<readonly CustomerOrderSummary[]>;
  getDetail(input: CustomerOrderRequest & { readonly orderId: string }): Promise<CustomerOrderDetail>;
}

interface CustomerOrderRequest {
  readonly shop: string;
  readonly sessionId: string;
  readonly customerId: string | null;
}

const AUTH_CHALLENGE_SECONDS = 5 * 60;
const AUDIT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const AUTH_START_WINDOW_SECONDS = 15 * 60;
const ORDER_READ_WINDOW_SECONDS = 60;

export function createCustomerOrderService(config: CustomerOrderServiceConfig): CustomerOrderService {
  const now = config.now ?? Date.now;
  const makeBytes = config.randomBytes ?? randomBytes;
  const makeId = config.randomId ?? randomUUID;
  const sleep = config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = config.random ?? Math.random;
  const maxRecent = Math.max(1, Math.min(5, config.maxRecent ?? 5));
  const sessionSeconds = Math.max(60, Math.min(15 * 60, (config.sessionMinutes ?? 15) * 60));
  const expectedShop = normalizeShop(config.shopDomain);
  const allowedReturnOrigin = new URL(config.allowedReturnOrigin).origin;

  const loadAuthorized = async (input: CustomerOrderRequest) => {
    if (normalizeShop(input.shop) !== expectedShop) {
      throw new CustomerOrderServiceError("forbidden", 403, "Order access is unavailable.");
    }

    const sessionId = parseSessionId(input.sessionId);
    const session = await config.repository.loadSession(sessionId);
    const nowSeconds = Math.floor(now() / 1_000);
    if (!session || session.expiresAt <= nowSeconds) {
      if (session) await config.repository.deleteSession(sessionId);
      throw new CustomerOrderServiceError(
        "authentication_required",
        401,
        "Sign in to view your recent orders.",
      );
    }
    if (
      normalizeShop(session.shop) !== expectedShop ||
      (input.customerId !== null && !sameCustomer(session.customerId, input.customerId))
    ) {
      await config.repository.deleteSession(sessionId);
      throw new CustomerOrderServiceError(
        "authentication_required",
        401,
        "Sign in again to view your recent orders.",
      );
    }

    const rateKey = hash(`read:${sessionId}`);
    const window = Math.floor(nowSeconds / ORDER_READ_WINDOW_SECONDS) * ORDER_READ_WINDOW_SECONDS;
    if (!await config.repository.consumeRateLimit(rateKey, window, 10)) {
      throw new CustomerOrderServiceError("rate_limited", 429, "Please wait a moment and try again.");
    }

    let accessToken: string;
    try {
      accessToken = await config.cipher.decrypt(session.encryptedAccessToken, tokenContext(sessionId));
    } catch {
      await config.repository.deleteSession(sessionId);
      throw new CustomerOrderServiceError(
        "authentication_required",
        401,
        "Sign in again to view your recent orders.",
      );
    }
    return { session, accessToken, sessionId };
  };

  return {
    async beginAuthentication(input) {
      const sessionId = parseSessionId(input.sessionId);
      if (normalizeShop(input.shop) !== expectedShop) {
        throw new CustomerOrderServiceError("forbidden", 403, "Order access is unavailable.");
      }
      const returnUrl = validateReturnUrl(input.returnUrl, allowedReturnOrigin);
      const nowMs = now();
      const nowSeconds = Math.floor(nowMs / 1_000);
      const rateKey = hash(`auth:${expectedShop}:${sessionId}:${input.sourceAddress ?? "unknown"}`);
      const window = Math.floor(nowSeconds / AUTH_START_WINDOW_SECONDS) * AUTH_START_WINDOW_SECONDS;
      if (!await config.repository.consumeRateLimit(rateKey, window, 5)) {
        throw new CustomerOrderServiceError("rate_limited", 429, "Please wait before signing in again.");
      }

      const state = base64Url(makeBytes(32));
      const nonce = base64Url(makeBytes(32));
      const codeVerifier = base64Url(makeBytes(48));
      const encryptedCodeVerifier = await config.cipher.encrypt(codeVerifier, challengeContext(hash(state)));
      await config.repository.createChallenge({
        stateHash: hash(state),
        shop: expectedShop,
        sessionId,
        nonceHash: hash(nonce),
        encryptedCodeVerifier,
        returnUrl,
        createdAt: nowMs,
        expiresAt: nowSeconds + AUTH_CHALLENGE_SECONDS,
      });
      const authorizationUrl = await config.access.createAuthorizationUrl({
        state,
        nonce,
        codeChallenge: hashBase64Url(codeVerifier),
        redirectUri: config.callbackUrl,
      });
      return { authorizationUrl };
    },

    async completeAuthentication(input) {
      if (!input.state) return authenticationResultUrl(allowedReturnOrigin, "failed");
      const stateHash = hash(input.state);
      const challenge = await config.repository.consumeChallenge(stateHash);
      if (!challenge) return authenticationResultUrl(allowedReturnOrigin, "expired");
      const returnUrl = safeAuthenticationReturn(challenge.returnUrl, allowedReturnOrigin);

      const nowSeconds = Math.floor(now() / 1_000);
      if (
        normalizeShop(challenge.shop) !== expectedShop ||
        challenge.expiresAt <= nowSeconds ||
        input.error ||
        !input.code ||
        input.code.length > 4_096
      ) {
        return authenticationResultUrl(returnUrl, input.error ? "cancelled" : "expired");
      }

      let stage: "decrypt_verifier" | "exchange_code" | "validate_nonce" | "encrypt_token" | "save_session" =
        "decrypt_verifier";
      try {
        const codeVerifier = await config.cipher.decrypt(
          challenge.encryptedCodeVerifier,
          challengeContext(stateHash),
        );
        stage = "exchange_code";
        const grant = await config.access.exchangeAuthorizationCode({
          code: input.code,
          codeVerifier,
          redirectUri: config.callbackUrl,
        });
        stage = "validate_nonce";
        if (hash(grant.nonce) !== challenge.nonceHash) {
          config.onAuthFailure?.({ stage, category: "nonce_mismatch" });
          return authenticationResultUrl(returnUrl, "failed");
        }
        const expiresAt = nowSeconds + Math.min(sessionSeconds, Math.max(1, grant.expiresInSeconds));
        stage = "encrypt_token";
        const encryptedAccessToken = await config.cipher.encrypt(
          grant.accessToken,
          tokenContext(challenge.sessionId),
        );
        stage = "save_session";
        await config.repository.saveSession({
          shop: challenge.shop,
          sessionId: challenge.sessionId,
          customerId: grant.customerId,
          encryptedAccessToken,
          createdAt: now(),
          expiresAt,
        });
        return authenticationResultUrl(returnUrl, "success");
      } catch (error) {
        config.onAuthFailure?.({ stage, category: safeAuthFailureCategory(error) });
        return authenticationResultUrl(returnUrl, "failed");
      }
    },

    async listRecent(input) {
      const startedAt = now();
      let auth: Awaited<ReturnType<typeof loadAuthorized>> | undefined;
      let result: CustomerOrderAuditResult = "unavailable";
      try {
        auth = await loadAuthorized(input);
        const orders = await withOneRetry(
          () => config.access.listRecentOrders(auth!.accessToken, maxRecent),
          sleep,
          random,
        );
        if (!sameCustomer(auth.session.customerId, orders.customerId)) {
          await config.repository.deleteSession(auth.sessionId);
          result = "forbidden";
          throw new CustomerOrderServiceError(
            "authentication_required",
            401,
            "Sign in again to view your recent orders.",
          );
        }
        result = orders.orders.length ? "success" : "empty";
        return orders.orders.slice(0, maxRecent);
      } catch (error) {
        result = auditResult(error);
        throw normalizeServiceError(error);
      } finally {
        const auditSessionId = auth?.sessionId ?? safeSessionId(input.sessionId);
        if (auditSessionId) {
          await writeAudit(
            config,
            auditSessionId,
            auth?.session.customerId ?? null,
            "recent",
            result,
            startedAt,
            now(),
            makeId(),
          );
        }
      }
    },

    async getDetail(input) {
      const startedAt = now();
      let auth: Awaited<ReturnType<typeof loadAuthorized>> | undefined;
      let result: CustomerOrderAuditResult = "unavailable";
      try {
        if (!isOpaqueShopifyId(input.orderId)) {
          throw new CustomerOrderServiceError("not_found", 404, "Order not found.");
        }
        auth = await loadAuthorized(input);
        const order = await withOneRetry(
          () => config.access.getOrder(auth!.accessToken, input.orderId),
          sleep,
          random,
        );
        if (!order) {
          result = "not_found";
          throw new CustomerOrderServiceError("not_found", 404, "Order not found.");
        }
        result = "success";
        return order;
      } catch (error) {
        result = auditResult(error);
        throw normalizeServiceError(error);
      } finally {
        const auditSessionId = auth?.sessionId ?? safeSessionId(input.sessionId);
        if (auditSessionId) {
          await writeAudit(
            config,
            auditSessionId,
            auth?.session.customerId ?? null,
            "detail",
            result,
            startedAt,
            now(),
            makeId(),
          );
        }
      }
    },
  };
}

function safeAuthFailureCategory(error: unknown): string {
  if (error instanceof CustomerOrderApiError) {
    const providerCode = /\(([a-z_]+)\)$/.exec(error.message)?.[1];
    const status = /\bHTTP (\d{3})\b/.exec(error.message)?.[1];
    const validationCode = new Map<string, string>([
      ["Shopify identity token is malformed", "token_malformed"],
      ["Shopify identity token uses an unsupported signature", "unsupported_signature"],
      ["Shopify signing key was not found", "signing_key_not_found"],
      ["Shopify signing key is invalid", "signing_key_invalid"],
      ["Shopify identity token signature is invalid", "signature_invalid"],
      ["Shopify identity token claims are invalid", "claims_invalid"],
    ]).get(error.message);
    return [error.kind, status ? `http_${status}` : null, providerCode ?? validationCode ?? null]
      .filter(Boolean)
      .join(":");
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]+$/.test(error.name)) return error.name;
  return "unknown";
}

async function withOneRetry<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void>,
  random: () => number,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof CustomerOrderApiError) || !isTransient(error)) throw error;
    const delay = Math.min(1_000, error.retryAfterMs ?? 100 + Math.floor(random() * 100));
    await sleep(delay);
    return operation();
  }
}

function isTransient(error: CustomerOrderApiError): boolean {
  return error.kind === "rate_limited" || error.kind === "unavailable";
}

function normalizeServiceError(error: unknown): CustomerOrderServiceError {
  if (error instanceof CustomerOrderServiceError) return error;
  if (error instanceof CustomerOrderApiError) {
    if (error.kind === "authentication") {
      return new CustomerOrderServiceError("authentication_required", 401, "Sign in again to view your recent orders.");
    }
    if (error.kind === "not_found") {
      return new CustomerOrderServiceError("not_found", 404, "Order not found.");
    }
    if (error.kind === "rate_limited") {
      return new CustomerOrderServiceError("rate_limited", 503, "Orders are temporarily unavailable.");
    }
  }
  return new CustomerOrderServiceError("unavailable", 503, "Orders are temporarily unavailable.");
}

function auditResult(error: unknown): CustomerOrderAuditResult {
  if (error instanceof CustomerOrderServiceError) {
    if (error.code === "authentication_required") return "authentication_required";
    if (error.code === "forbidden") return "forbidden";
    if (error.code === "not_found") return "not_found";
    if (error.code === "rate_limited") return "rate_limited";
    return "unavailable";
  }
  if (error instanceof CustomerOrderApiError) {
    if (error.kind === "authentication") return "authentication_required";
    if (error.kind === "not_found") return "not_found";
    if (error.kind === "rate_limited") return "rate_limited";
    if (error.kind === "invalid_response") return "invalid_response";
  }
  return "unavailable";
}

async function writeAudit(
  config: CustomerOrderServiceConfig,
  sessionId: SessionId,
  customerId: CustomerId | null,
  operation: "recent" | "detail",
  result: CustomerOrderAuditResult,
  startedAt: number,
  completedAt: number,
  id: string,
): Promise<void> {
  try {
    await config.repository.appendAudit({
      id,
      shop: normalizeShop(config.shopDomain),
      sessionId,
      customerReference: customerId ? hash(String(customerId)).slice(0, 24) : null,
      operation,
      result,
      latencyMs: Math.max(0, completedAt - startedAt),
      createdAt: completedAt,
    }, Math.floor(completedAt / 1_000) + AUDIT_RETENTION_SECONDS);
  } catch {
    // Audit storage must never expose or replace the customer safe response.
  }
}

function validateReturnUrl(value: string, allowedOrigin: string): string {
  try {
    if (value.length > 2_048) throw new Error();
    const url = new URL(value);
    if (url.origin !== allowedOrigin || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new CustomerOrderServiceError("invalid_request", 400, "Return location is not allowed.");
  }
}

function authenticationResultUrl(returnUrl: string, result: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set("order_auth", result);
  return url.toString();
}

function safeAuthenticationReturn(value: string, allowedOrigin: string): string {
  try {
    return validateReturnUrl(value, allowedOrigin);
  } catch {
    return allowedOrigin;
  }
}

function parseSessionId(value: string): SessionId {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new CustomerOrderServiceError("invalid_request", 400, "Session is invalid.");
  }
  return SessionId(value);
}

function safeSessionId(value: string): SessionId | null {
  try {
    return parseSessionId(value);
  } catch {
    return null;
  }
}

function isOpaqueShopifyId(value: string): boolean {
  return /^gid:\/\/shopify\/Order\/[A-Za-z0-9_-]+$/.test(value);
}

function sameCustomer(left: string, right: string): boolean {
  return left === right || lastIdPart(left) === lastIdPart(right);
}

function lastIdPart(value: string): string {
  return value.split("/").at(-1) ?? value;
}

function normalizeShop(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBase64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function challengeContext(stateHash: string): Record<string, string> {
  return { purpose: "customer-order-auth-challenge", stateHash };
}

function tokenContext(sessionId: SessionId): Record<string, string> {
  return { purpose: "customer-order-access-token", sessionId: String(sessionId) };
}
