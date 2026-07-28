/**
 * Shopify Storefront API client.
 *
 * ============================================================================
 * WHY STOREFRONT AND NOT ADMIN — the most important line in this file
 * ============================================================================
 *
 * Shopify offers two APIs. The Admin API can read customers, orders, payouts,
 * and can WRITE almost anything. The Storefront API sees only what a shopper
 * browsing the site could see, and is read-only.
 *
 * We use Storefront exclusively. That is a deliberate security boundary, not a
 * convenience: if this token leaked entirely, the attacker gains the ability to
 * read a public product catalogue. Nothing more. Combined with a tool surface
 * that has no write operations (docs/10-operations.md §10.6), a perfectly
 * executed prompt injection against this bot can, at worst, search products.
 *
 * ⚠️ NEVER swap this for the Admin API to "make something easier". If a feature
 * seems to require it, that feature is asking the bot to act rather than answer
 * — which is a Phase 12 conversation with its own guardrails, not a token swap.
 *
 * SCOPES REQUIRED (verified against the Storefront API docs):
 *   unauthenticated_read_product_listings  — products, variants, prices
 *
 * OPTIONAL, and note the trade-off:
 *   ProductVariant.quantityAvailable requires additional token access. Without
 *   it the field is null. We treat exact stock counts as a nice-to-have and rely
 *   on `availableForSale` (always present) for the in-stock decision — so the
 *   bot works correctly on the minimal scope.
 */

import { CatalogUnavailable } from "@nailzify/core";

/**
 * Which kind of Storefront token is configured.
 *
 * ⚠️ THEY USE DIFFERENT HEADERS. Sending a private token under the public
 * header (or vice versa) returns 401 with no indication that the header is the
 * problem — it reads exactly like a bad token or a missing scope.
 *
 *   public   X-Shopify-Storefront-Access-Token   browsers/mobile, meters per BUYER IP
 *   private  Shopify-Storefront-Private-Token    server-side only, must stay secret
 *
 * ⚠️ WHERE EACH ONE COMES FROM — they are not both on the same page.
 *
 *   PUBLIC   Develop apps -> your app -> API credentials ->
 *            "Storefront API access token". This is what a custom app gives you.
 *
 *   PRIVATE  NOT on that page. Obtained by adding the Headless channel to the
 *            store, creating a delegate access token, or requesting
 *            unauthenticated scopes on an existing token.
 *
 * PREFER PRIVATE IN PRODUCTION. Public tokens meter by CUSTOMER IP, but every
 * call we make originates from a handful of Lambda IPs — so all shoppers would
 * share one rate-limit bucket and throttle under modest load. Private meters per
 * token and is the intended path for a server-side caller.
 *
 * Public is perfectly workable for development and low traffic. The adapter
 * supports both so the migration is a config change, not a code change.
 */
export type StorefrontTokenKind = "private" | "public";

export interface StorefrontClientConfig {
  /** e.g. `nailzify.myshopify.com` — the permanent domain, not a custom one. */
  readonly shopDomain: string;
  readonly accessToken: string;
  /** Defaults to `private` — the correct choice for server-side calls. */
  readonly tokenKind?: StorefrontTokenKind;
  /**
   * Resolves the end customer's IP for the current request.
   *
   * Private tokens REQUIRE `Shopify-Storefront-Buyer-IP` when serving buyer
   * traffic, so Shopify can apply bot protection and meter correctly. Without
   * it, our Lambda looks like one very busy client rather than many shoppers.
   *
   * A callback rather than a value because the client is constructed ONCE per
   * Lambda execution context and reused across requests — a static IP would be
   * whichever customer happened to arrive first. Wire it to per-request state
   * (AsyncLocalStorage) in the composition root.
   */
  readonly buyerIp?: () => string | undefined;
  /**
   * Pinned API version, e.g. `2025-10`.
   *
   * PIN IT EXPLICITLY. Shopify releases quarterly and supports each version for
   * a year. An unpinned client silently follows the latest release and can break
   * on a schema change you did not choose to adopt.
   */
  readonly apiVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly { message: string; extensions?: { code?: string } }[];
  readonly extensions?: {
    readonly cost?: {
      readonly requestedQueryCost: number;
      readonly actualQueryCost: number;
      readonly throttleStatus: {
        readonly maximumAvailable: number;
        readonly currentlyAvailable: number;
        readonly restoreRate: number;
      };
    };
  };
}

export interface StorefrontClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Cost of the most recent call. Feeds the ShopifyThrottle metric. */
  lastCost(): GraphQLResponse<unknown>["extensions"] extends infer E ? E : never;
}

export function createStorefrontClient(config: StorefrontClientConfig): StorefrontClient {
  const endpoint = `https://${config.shopDomain}/api/${config.apiVersion}/graphql.json`;
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5_000;

  let lastExtensions: GraphQLResponse<unknown>["extensions"];

  return {
    lastCost: () => lastExtensions as never,

    async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      // Shopify hydration sits in the chat request path. A hung connection is
      // customer-facing latency, so bound it rather than inheriting the default.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(config.tokenKind === "public"
          ? { "X-Shopify-Storefront-Access-Token": config.accessToken }
          : { "Shopify-Storefront-Private-Token": config.accessToken }),
      };

      // Only meaningful with a private token, and only when we actually know the
      // buyer. Sending a wrong or absent IP is worse than omitting the header.
      const ip = config.buyerIp?.();
      if (ip && config.tokenKind !== "public") headers["Shopify-Storefront-Buyer-IP"] = ip;

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables: variables ?? {} }),
          signal: controller.signal,
        });
      } catch (cause) {
        throw new CatalogUnavailable("Shopify request failed or timed out", { cause });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // 430 is Shopify's "shop throttled" status; 429 is standard rate limit.
        throw new CatalogUnavailable(
          `Shopify returned HTTP ${response.status}`,
          { cause: new Error(await safeText(response)) },
        );
      }

      const body = (await response.json()) as GraphQLResponse<T>;
      lastExtensions = body.extensions;

      // ⚠️ GRAPHQL RETURNS 200 ON ERRORS. A client that only checks
      // `response.ok` will happily treat a failed query as success and then
      // crash on undefined data — or worse, silently return an empty product
      // list, which the bot reports as "we don't sell that".
      if (body.errors?.length) {
        throw new CatalogUnavailable(
          `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      }

      if (!body.data) {
        throw new CatalogUnavailable("Shopify returned no data");
      }

      return body.data;
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
