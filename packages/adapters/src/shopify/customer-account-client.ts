import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import {
  CustomerId,
  CustomerOrderApiError,
  type CustomerOrderAccess,
  type CustomerOrderDetail,
  type CustomerOrderMoney,
  type CustomerOrderSummary,
} from "@nailzify/core";

export interface CustomerAccountClientConfig {
  readonly storefrontDomain: string;
  readonly shopDomain: string;
  readonly clientId: string;
  /** Exact origin registered in Shopify's customer_authentication settings. */
  readonly javascriptOrigin: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface OpenIdConfig {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly issuer: string;
}

interface CustomerApiConfig {
  readonly graphql_api: string;
}

interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly id_token?: unknown;
  readonly expires_in?: unknown;
}

interface GraphQlEnvelope<T> {
  readonly data?: T;
  readonly errors?: readonly {
    readonly message?: string;
    readonly extensions?: { readonly code?: string };
  }[];
}

const RECENT_ORDERS_QUERY = `
  query RecentCustomerOrders($first: Int!) {
    customer {
      id
      orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          totalPrice { amount currencyCode }
          financialStatus
          fulfillmentStatus
        }
      }
    }
  }
`;

const CUSTOMER_IDENTITY_QUERY = `
  query CustomerIdentity {
    customer { id }
  }
`;

const ORDER_DETAIL_QUERY = `
  query CustomerOrderDetail($first: Int!) {
    customer {
      orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          totalPrice { amount currencyCode }
          financialStatus
          fulfillmentStatus
          lineItems(first: 50) {
            nodes { name quantity }
          }
          fulfillments(first: 10) {
            nodes {
              trackingInformation { company number url }
            }
          }
        }
      }
    }
  }
`;

export function createCustomerAccountClient(
  config: CustomerAccountClientConfig,
): CustomerOrderAccess {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5_000;
  const now = config.now ?? Date.now;
  let openIdCache: Promise<OpenIdConfig> | undefined;
  let customerApiCache: Promise<CustomerApiConfig> | undefined;
  let jwksCache: Promise<readonly Jwk[]> | undefined;

  const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
    assertAllowedEndpoint(url, config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "User-Agent": "storefront-order-chat/1.0",
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
        const providerError = await safeProviderError(response);
        if (response.status === 401 || response.status === 403) {
          throw new CustomerOrderApiError(
            "authentication",
            providerError
              ? `Shopify customer authentication failed HTTP ${response.status} (${providerError})`
              : `Shopify customer authentication failed HTTP ${response.status}`,
          );
        }
        if (response.status === 429 || response.status === 430) {
          throw new CustomerOrderApiError("rate_limited", "Shopify rate limited the request", retryAfterMs);
        }
        if (response.status >= 500) {
          throw new CustomerOrderApiError("unavailable", "Shopify is temporarily unavailable", retryAfterMs);
        }
        throw new CustomerOrderApiError(
          "invalid_response",
          providerError
            ? `Shopify returned HTTP ${response.status} (${providerError})`
            : `Shopify returned HTTP ${response.status}`,
        );
      }
      try {
        return await response.json() as T;
      } catch {
        throw new CustomerOrderApiError("invalid_response", "Shopify returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof CustomerOrderApiError) throw error;
      throw new CustomerOrderApiError("unavailable", "Shopify request failed or timed out");
    } finally {
      clearTimeout(timer);
    }
  };

  const openId = () => {
    openIdCache ??= fetchJson<OpenIdConfig>(
      `https://${config.storefrontDomain}/.well-known/openid-configuration`,
    ).then((value) => validateOpenIdConfig(value, config));
    return openIdCache;
  };

  const customerApi = () => {
    customerApiCache ??= fetchJson<CustomerApiConfig>(
      `https://${config.storefrontDomain}/.well-known/customer-account-api`,
    ).then((value) => {
      if (!value || typeof value.graphql_api !== "string") {
        throw new CustomerOrderApiError("invalid_response", "Shopify customer API discovery is invalid");
      }
      assertAllowedEndpoint(value.graphql_api, config);
      return value;
    });
    return customerApiCache;
  };

  const graphql = async <T>(accessToken: string, query: string, variables: object): Promise<T> => {
    const endpoint = (await customerApi()).graphql_api;
    const envelope = await fetchJson<GraphQlEnvelope<T>>(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (envelope.errors?.length) {
      const codes = envelope.errors.map((error) => error.extensions?.code ?? "");
      if (codes.some((code) => /THROTTL/i.test(code))) {
        throw new CustomerOrderApiError("rate_limited", "Shopify rate limited the GraphQL request");
      }
      if (codes.some((code) => /AUTH|ACCESS|UNAUTHORIZED/i.test(code))) {
        throw new CustomerOrderApiError(
          "authentication",
          `Shopify rejected the customer token (${safeGraphqlAuthCategory(codes)})`,
        );
      }
      throw new CustomerOrderApiError("invalid_response", "Shopify rejected the order query");
    }
    if (!envelope.data) {
      throw new CustomerOrderApiError("invalid_response", "Shopify returned no order data");
    }
    return envelope.data;
  };

  return {
    async createAuthorizationUrl(input) {
      const discovery = await openId();
      const url = new URL(discovery.authorization_endpoint);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", "openid email customer-account-api:full");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async exchangeAuthorizationCode(input) {
      const discovery = await openId();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: input.redirectUri,
        code: input.code,
        code_verifier: input.codeVerifier,
      });
      const token = await fetchJson<TokenResponse>(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: registeredJavascriptOrigin(config.javascriptOrigin),
        },
        body,
      });

      if (
        typeof token.access_token !== "string" ||
        typeof token.id_token !== "string" ||
        typeof token.expires_in !== "number" ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0
      ) {
        throw new CustomerOrderApiError("invalid_response", "Shopify token response is incomplete");
      }

      const claims = await verifyIdToken(token.id_token, discovery, config, () => {
        jwksCache ??= fetchJson<{ keys?: readonly Jwk[] }>(discovery.jwks_uri).then((value) => {
          if (!Array.isArray(value.keys)) {
            throw new CustomerOrderApiError("invalid_response", "Shopify signing keys are invalid");
          }
          return value.keys;
        });
        return jwksCache;
      });
      const identity = await graphql<CustomerIdentityData>(
        token.access_token,
        CUSTOMER_IDENTITY_QUERY,
        {},
      );
      if (!isCustomerIdentityData(identity)) {
        throw new CustomerOrderApiError("invalid_response", "Shopify customer identity response is invalid");
      }

      return {
        accessToken: token.access_token,
        customerId: CustomerId(identity.customer.id),
        nonce: claims.nonce,
        expiresInSeconds: token.expires_in,
      };
    },

    async listRecentOrders(accessToken, limit) {
      const data = await graphql<RecentOrdersData>(accessToken, RECENT_ORDERS_QUERY, {
        first: Math.max(1, Math.min(5, Math.trunc(limit))),
      });
      if (!isRecentOrdersData(data)) {
        throw new CustomerOrderApiError("invalid_response", "Shopify recent orders response is invalid");
      }
      return {
        customerId: CustomerId(data.customer.id),
        orders: data.customer.orders.nodes.map(toSummary),
      };
    },

    async getOrder(accessToken, orderId) {
      const data = await graphql<OrderDetailData>(accessToken, ORDER_DETAIL_QUERY, { first: 5 });
      if (!isOrderDetailData(data)) {
        throw new CustomerOrderApiError("invalid_response", "Shopify order response is invalid");
      }
      const order = data.customer.orders.nodes.find((candidate) => candidate.id === orderId);
      if (!order) return null;
      return {
        ...toSummary(order),
        lineItems: order.lineItems.nodes.map((item) => ({
          name: item.name,
          quantity: item.quantity,
        })),
        tracking: order.fulfillments.nodes.flatMap((fulfillment) =>
          fulfillment.trackingInformation.map((tracking) => ({
            company: nullableString(tracking.company),
            number: nullableString(tracking.number),
            url: safeTrackingUrl(tracking.url),
          })),
        ),
      };
    },
  };
}

interface OrderNode {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly totalPrice: CustomerOrderMoney;
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string;
}

interface RecentOrdersData {
  readonly customer: {
    readonly id: string;
    readonly orders: { readonly nodes: readonly OrderNode[] };
  };
}

interface CustomerIdentityData {
  readonly customer: { readonly id: string };
}

interface DetailedOrderNode extends OrderNode {
  readonly lineItems: {
    readonly nodes: readonly { readonly name: string; readonly quantity: number }[];
  };
  readonly fulfillments: {
    readonly nodes: readonly {
      readonly trackingInformation: readonly {
        readonly company: string | null;
        readonly number: string | null;
        readonly url: string | null;
      }[];
    }[];
  };
}

interface OrderDetailData {
  readonly customer: {
    readonly orders: { readonly nodes: readonly DetailedOrderNode[] };
  };
}

function toSummary(order: OrderNode): CustomerOrderSummary {
  return {
    id: order.id,
    name: order.name,
    createdAt: order.createdAt,
    total: { amount: order.totalPrice.amount, currencyCode: order.totalPrice.currencyCode },
    financialStatus: nullableString(order.financialStatus),
    fulfillmentStatus: order.fulfillmentStatus,
  };
}

function isRecentOrdersData(value: unknown): value is RecentOrdersData {
  if (!value || typeof value !== "object") return false;
  const customer = (value as Record<string, unknown>)["customer"];
  if (!customer || typeof customer !== "object") return false;
  const record = customer as Record<string, unknown>;
  const orders = record["orders"];
  return typeof record["id"] === "string" &&
    !!orders && typeof orders === "object" &&
    Array.isArray((orders as Record<string, unknown>)["nodes"]) &&
    ((orders as Record<string, unknown>)["nodes"] as unknown[]).every((order) => isOrderNode(order, false));
}

function isCustomerIdentityData(value: unknown): value is CustomerIdentityData {
  if (!value || typeof value !== "object") return false;
  const customer = (value as Record<string, unknown>)["customer"];
  return !!customer && typeof customer === "object" &&
    typeof (customer as Record<string, unknown>)["id"] === "string";
}

function isOrderNode(value: unknown, detailed: boolean): value is DetailedOrderNode {
  if (!value || typeof value !== "object") return false;
  const order = value as Record<string, unknown>;
  const money = order["totalPrice"];
  const base = typeof order["id"] === "string" &&
    typeof order["name"] === "string" &&
    typeof order["createdAt"] === "string" &&
    typeof order["fulfillmentStatus"] === "string" &&
    (order["financialStatus"] === null || typeof order["financialStatus"] === "string") &&
    !!money && typeof money === "object" &&
    typeof (money as Record<string, unknown>)["amount"] === "string" &&
    typeof (money as Record<string, unknown>)["currencyCode"] === "string";
  if (!base || !detailed) return base;
  return isConnection(order["lineItems"], isLineItem) &&
    isConnection(order["fulfillments"], isFulfillment);
}

function isOrderDetailData(value: unknown): value is OrderDetailData {
  if (!value || typeof value !== "object") return false;
  const customer = (value as Record<string, unknown>)["customer"];
  if (!customer || typeof customer !== "object") return false;
  return isConnection(
    (customer as Record<string, unknown>)["orders"],
    (order) => isOrderNode(order, true),
  );
}

function isConnection<T>(
  value: unknown,
  itemGuard: (item: unknown) => item is T,
): value is { readonly nodes: readonly T[] } {
  if (!value || typeof value !== "object") return false;
  const nodes = (value as Record<string, unknown>)["nodes"];
  return Array.isArray(nodes) && nodes.every(itemGuard);
}

function isLineItem(value: unknown): value is { readonly name: string; readonly quantity: number } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["name"] === "string" &&
    typeof item["quantity"] === "number" &&
    Number.isInteger(item["quantity"]) &&
    item["quantity"] >= 0;
}

function isFulfillment(value: unknown): value is DetailedOrderNode["fulfillments"]["nodes"][number] {
  if (!value || typeof value !== "object") return false;
  const tracking = (value as Record<string, unknown>)["trackingInformation"];
  return Array.isArray(tracking) && tracking.every((item) => {
    if (!item || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    return isNullableString(entry["company"]) &&
      isNullableString(entry["number"]) &&
      isNullableString(entry["url"]);
  });
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function safeTrackingUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function safeProviderError(response: Response): Promise<string | null> {
  const allowed = new Set([
    "access_denied",
    "invalid_client",
    "invalid_grant",
    "invalid_request",
    "invalid_scope",
    "invalid_token",
    "server_error",
    "temporarily_unavailable",
    "unauthorized_client",
  ]);
  const header = response.headers.get("www-authenticate") ?? "";
  const headerMatch = /(?:^|[, ]+)error=["']?([a-z_]+)/i.exec(header)?.[1]?.toLowerCase();
  if (headerMatch && allowed.has(headerMatch)) return headerMatch;
  try {
    const body = await response.json() as { readonly error?: unknown };
    const value = typeof body.error === "string" ? body.error.toLowerCase() : "";
    return allowed.has(value) ? value : null;
  } catch {
    return null;
  }
}

function safeGraphqlAuthCategory(codes: readonly string[]): string {
  if (codes.some((code) => /UNAUTHENTICATED/i.test(code))) return "graphql_unauthenticated";
  if (codes.some((code) => /UNAUTHORIZED/i.test(code))) return "graphql_unauthorized";
  if (codes.some((code) => /ACCESS/i.test(code))) return "graphql_access_denied";
  return "graphql_authentication_error";
}

function registeredJavascriptOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) throw new Error();
    return url.origin;
  } catch {
    throw new CustomerOrderApiError(
      "invalid_response",
      "Shopify customer authentication origin is invalid",
    );
  }
}

function validateOpenIdConfig(value: OpenIdConfig, config: CustomerAccountClientConfig): OpenIdConfig {
  if (
    !value ||
    typeof value.authorization_endpoint !== "string" ||
    typeof value.token_endpoint !== "string" ||
    typeof value.jwks_uri !== "string" ||
    typeof value.issuer !== "string"
  ) {
    throw new CustomerOrderApiError("invalid_response", "Shopify OpenID discovery is invalid");
  }
  assertAllowedEndpoint(value.authorization_endpoint, config);
  assertAllowedEndpoint(value.token_endpoint, config);
  assertAllowedEndpoint(value.jwks_uri, config);
  return value;
}

function assertAllowedEndpoint(urlValue: string, config: CustomerAccountClientConfig): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new CustomerOrderApiError("invalid_response", "Shopify endpoint is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new CustomerOrderApiError("invalid_response", "Shopify endpoint must use HTTPS");
  }
  const host = url.hostname.toLowerCase();
  const storefront = config.storefrontDomain.toLowerCase();
  const shop = config.shopDomain.toLowerCase();
  const allowed = host === storefront || host.endsWith(`.${storefront}`) || host === shop ||
    host.endsWith(".myshopify.com") || host === "shopify.com" || host.endsWith(".shopify.com");
  if (!allowed) {
    throw new CustomerOrderApiError("invalid_response", "Shopify discovery returned an untrusted host");
  }
}

async function verifyIdToken(
  token: string,
  discovery: OpenIdConfig,
  config: CustomerAccountClientConfig,
  loadKeys: () => Promise<readonly Jwk[]>,
): Promise<{ readonly nonce: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new CustomerOrderApiError("authentication", "Shopify identity token is malformed");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new CustomerOrderApiError("authentication", "Shopify identity token is malformed");
  }
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") {
    throw new CustomerOrderApiError("authentication", "Shopify identity token uses an unsupported signature");
  }
  const key = (await loadKeys()).find((candidate) => candidate.kid === header["kid"] && candidate.kty === "RSA");
  if (!key) throw new CustomerOrderApiError("authentication", "Shopify signing key was not found");
  let publicKey;
  try {
    publicKey = createPublicKey({ key: key as JsonWebKey, format: "jwk" });
  } catch {
    throw new CustomerOrderApiError("authentication", "Shopify signing key is invalid");
  }
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    publicKey,
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!valid) throw new CustomerOrderApiError("authentication", "Shopify identity token signature is invalid");

  const nowSeconds = Math.floor((config.now?.() ?? Date.now()) / 1000);
  const audience = claims["aud"];
  const audienceMatches = audience === config.clientId ||
    (Array.isArray(audience) && audience.includes(config.clientId));
  const authorizedPartyMatches = !Array.isArray(audience) ||
    audience.length <= 1 ||
    claims["azp"] === config.clientId;
  if (claims["iss"] !== discovery.issuer) throw invalidTokenClaim("issuer_mismatch");
  if (!audienceMatches) throw invalidTokenClaim("audience_mismatch");
  if (!authorizedPartyMatches) throw invalidTokenClaim("authorized_party_mismatch");
  if (typeof claims["nonce"] !== "string" || !claims["nonce"]) throw invalidTokenClaim("nonce_missing");
  if (typeof claims["exp"] !== "number") throw invalidTokenClaim("expiry_missing");
  if (claims["exp"] <= nowSeconds - 60) throw invalidTokenClaim("expired");
  if (typeof claims["nbf"] === "number" && claims["nbf"] > nowSeconds + 60) {
    throw invalidTokenClaim("not_yet_valid");
  }
  if (typeof claims["iat"] !== "number") throw invalidTokenClaim("issued_at_missing");
  if (claims["iat"] > nowSeconds + 60) throw invalidTokenClaim("issued_in_future");
  if (claims["iat"] < nowSeconds - 10 * 60) throw invalidTokenClaim("issued_too_long_ago");
  return { nonce: claims["nonce"] };
}

function invalidTokenClaim(code: string): CustomerOrderApiError {
  return new CustomerOrderApiError(
    "authentication",
    `Shopify identity token claims are invalid (${code})`,
  );
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - nowMs, 1_000)) : null;
}
