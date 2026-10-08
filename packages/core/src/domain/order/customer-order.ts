import type { CustomerId, SessionId } from "../shared/brand.js";

/** Money exactly as Shopify returned it. Formatting belongs at the UI edge. */
export interface CustomerOrderMoney {
  readonly amount: string;
  readonly currencyCode: string;
}

export interface CustomerOrderSummary {
  /** Opaque Shopify id. Used only to select and revalidate an order. */
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly total: CustomerOrderMoney;
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string;
}

export interface CustomerOrderLineItem {
  readonly name: string;
  readonly quantity: number;
}

export interface CustomerOrderTracking {
  readonly company: string | null;
  readonly number: string | null;
  /** A Shopify supplied URL. The adapter rejects unsafe schemes. */
  readonly url: string | null;
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  readonly lineItems: readonly CustomerOrderLineItem[];
  readonly tracking: readonly CustomerOrderTracking[];
}

export interface CustomerOrdersResult {
  /** Used only for a defense in depth identity comparison. */
  readonly customerId: CustomerId;
  readonly orders: readonly CustomerOrderSummary[];
}

export interface CustomerOrderAuthChallenge {
  readonly stateHash: string;
  readonly shop: string;
  readonly sessionId: SessionId;
  readonly nonceHash: string;
  readonly encryptedCodeVerifier: string;
  readonly returnUrl: string;
  readonly createdAt: number;
  /** Unix time in seconds for DynamoDB TTL. */
  readonly expiresAt: number;
}

export interface CustomerOrderSession {
  readonly shop: string;
  readonly sessionId: SessionId;
  readonly customerId: CustomerId;
  readonly encryptedAccessToken: string;
  readonly createdAt: number;
  /** Unix time in seconds for DynamoDB TTL and request checks. */
  readonly expiresAt: number;
}

export type CustomerOrderAuditResult =
  | "success"
  | "empty"
  | "authentication_required"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "invalid_response";

export interface CustomerOrderAuditEvent {
  readonly id: string;
  readonly shop: string;
  readonly sessionId: SessionId;
  /** One way reference. Never the raw customer id. */
  readonly customerReference: string | null;
  readonly operation: "recent" | "detail";
  readonly result: CustomerOrderAuditResult;
  readonly latencyMs: number;
  readonly createdAt: number;
}
