/**
 * Shopify implementation of the `ProductCatalog` port.
 *
 * This is the hydration half of the two-plane design — the thing that turns a
 * `ProductCandidate` (an id and a score from the vector index) into a `Product`
 * (a price and a stock level, true as of this request).
 *
 * Everything a customer is shown about a product originates here.
 */

import type { Page, ProductCatalog } from "@nailzify/core";
import {
  CatalogUnavailable,
  ProductHandle,
  ProductId,
  fromDecimalString,
  type CurrencyCode,
  type Product,
  type ProductVariant,
} from "@nailzify/core";
import { parseMetafields, type RawMetafields } from "./attributes.js";
import type { StorefrontClient } from "./storefront-client.js";

/** `nodes(ids:)` accepts at most 250. We batch well under it. */
const MAX_IDS_PER_REQUEST = 100;

/** How many variants to pull per product. Nail sets rarely exceed a handful. */
const VARIANT_LIMIT = 20;

/**
 * The field selection, defined once and reused.
 *
 * ⚠️ Verified against the Storefront API schema. Two nullability details drove
 * real code below:
 *   - `onlineStoreUrl` is NULL when a product is not published to the Online
 *     Store sales channel. Linking a customer to `null` is a broken experience,
 *     so we fall back to the canonical handle URL.
 *   - `quantityAvailable` requires additional token access and is null without
 *     it. We never depend on it — `availableForSale` carries the decision.
 */
const PRODUCT_FIELDS = `
  id
  handle
  title
  description
  productType
  tags
  availableForSale
  onlineStoreUrl
  featuredImage { url }
  priceRange { minVariantPrice { amount currencyCode } }
  metafields(identifiers: [
    { namespace: "custom",  key: "nail_text" },
    { namespace: "custom",  key: "nail_type" },
    { namespace: "shopify", key: "color-pattern" },
    { namespace: "shopify", key: "finish" }
  ]) {
    namespace
    key
    value
    # shopify.* fields are taxonomy-backed: their value is a JSON array of
    # metaobject GIDs, so the readable label only exists here. Reading value
    # directly would store a gid:// string as if it were a colour.
    references(first: 5) {
      nodes { ... on Metaobject { field(key: "label") { value } } }
    }
  }
  variants(first: ${VARIANT_LIMIT}) {
    nodes {
      title
      availableForSale
      quantityAvailable
      price { amount currencyCode }
    }
  }
`;

const NODES_QUERY = `
  query HydrateProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { ${PRODUCT_FIELDS} }
    }
  }
`;

const BY_HANDLE_QUERY = `
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) { ${PRODUCT_FIELDS} }
  }
`;

const LIST_QUERY = `
  query ListProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      nodes { ${PRODUCT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface RawMoney {
  readonly amount: string;
  readonly currencyCode: string;
}

interface RawMetafield {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly references: { readonly nodes: { readonly field: { readonly value: string } | null }[] } | null;
}

interface RawProduct {
  readonly id: string;
  readonly handle: string;
  readonly title: string;
  readonly description: string;
  readonly productType: string;
  readonly tags: readonly string[];
  readonly availableForSale: boolean;
  readonly onlineStoreUrl: string | null;
  readonly featuredImage: { readonly url: string } | null;
  readonly priceRange: { readonly minVariantPrice: RawMoney };
  /** Aligned with the identifiers above; entries are null when unset. */
  readonly metafields?: readonly (RawMetafield | null)[];
  readonly variants: {
    readonly nodes: readonly {
      readonly title: string;
      readonly availableForSale: boolean;
      readonly quantityAvailable: number | null;
      readonly price: RawMoney;
    }[];
  };
}

export interface ShopifyProductCatalogConfig {
  readonly client: StorefrontClient;
  /** Public storefront domain, used to build fallback URLs. */
  readonly storefrontDomain: string;
  /** Receives merchandising tag warnings. Defaults to a no-op. */
  readonly onWarning?: (warning: string) => void;
}

export function createShopifyProductCatalog(
  config: ShopifyProductCatalogConfig,
): ProductCatalog {
  const warn = config.onWarning ?? (() => {});
  const convert = (raw: RawProduct): Product => toProduct(raw, config.storefrontDomain, warn);

  return {
    async getByIds(ids) {
      if (ids.length === 0) return [];

      const products: Product[] = [];

      // Batch rather than N round trips. Hydration is in the chat request path,
      // so this is the difference between one ~120ms hop and a timeout.
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        const data = await config.client.request<{ nodes: (RawProduct | null)[] }>(
          NODES_QUERY,
          { ids: [...batch] },
        );

        // `nodes` returns null for any id that no longer resolves — a product
        // deleted or unpublished since the last sync. Dropping it is CORRECT
        // behaviour, not an error: a stale vector must not be able to resurrect
        // a product that no longer exists. `hydrate()` in core reports the gap.
        for (const node of data.nodes) {
          if (node) products.push(convert(node));
        }
      }

      return products;
    },

    async getByHandle(handle) {
      const data = await config.client.request<{ productByHandle: RawProduct | null }>(
        BY_HANDLE_QUERY,
        { handle },
      );
      return data.productByHandle ? convert(data.productByHandle) : null;
    },

    async listAll(cursor) {
      const data = await config.client.request<{
        products: {
          nodes: readonly RawProduct[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(LIST_QUERY, { cursor: cursor ?? null });

      return {
        items: data.products.nodes.map(convert),
        cursor: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
      } satisfies Page<Product>;
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toProduct(
  raw: RawProduct,
  storefrontDomain: string,
  warn: (warning: string) => void,
): Product {
  const { attributes, warnings } = parseMetafields(toRawMetafields(raw.metafields), raw.title);
  for (const warning of warnings) warn(warning);

  const variants: ProductVariant[] = raw.variants.nodes.map((v) => ({
    title: v.title,
    price: toMoney(v.price),
    available: v.availableForSale,
    // Null unless the token carries inventory scope. Never load-bearing.
    quantityAvailable: v.quantityAvailable,
  }));

  return {
    id: ProductId(raw.id),
    handle: ProductHandle(raw.handle),
    title: raw.title,
    description: raw.description,
    productType: raw.productType,
    // onlineStoreUrl is null for products not published to the Online Store
    // channel. Sending a customer to "null" is worse than a constructed link.
    url: raw.onlineStoreUrl ?? `https://${storefrontDomain}/products/${raw.handle}`,
    imageUrl: raw.featuredImage?.url ?? null,
    price: toMoney(raw.priceRange.minVariantPrice),
    available: raw.availableForSale,
    variants,
    attributes,
    // Stamped so a stale hydration is detectable rather than assumed fresh.
    fetchedAt: Date.now(),
  };
}

/**
 * Pull the four metafields into a shape the parser understands.
 *
 * Matched by namespace+key rather than array position. The API returns entries
 * positionally aligned with the identifiers we sent, but relying on that makes
 * reordering the query a silent data-corruption bug rather than a compile error.
 */
function toRawMetafields(metafields: readonly (RawMetafield | null)[] | undefined): RawMetafields {
  // Tolerate the field being absent, not just its entries being null. Throwing
  // here would fail the whole hydration batch, and the tool registry reports a
  // failed batch to the customer as "we don't sell that" — a missing metafield
  // must degrade to "attribute unknown", which is what the parser already does.
  const list = metafields ?? [];
  const find = (namespace: string, key: string) =>
    list.find((m) => m?.namespace === namespace && m.key === key) ?? null;

  /** Resolved labels for a reference-typed field. */
  const labels = (m: RawMetafield | null): string[] =>
    (m?.references?.nodes ?? [])
      .map((n) => n.field?.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0);

  return {
    shape: find("custom", "nail_text")?.value?.trim() || null,
    style: find("custom", "nail_type")?.value?.trim() || null,
    colours: labels(find("shopify", "color-pattern")),
    finishes: labels(find("shopify", "finish")),
  };
}

const SUPPORTED_CURRENCIES: readonly string[] = ["USD", "GBP", "EUR", "CAD", "AUD"];

function toMoney(raw: RawMoney) {
  if (!SUPPORTED_CURRENCIES.includes(raw.currencyCode)) {
    // Fail loudly. Silently coercing an unknown currency to USD would show a
    // customer a number that is wrong by an exchange rate — the exact class of
    // error this architecture exists to prevent.
    throw new CatalogUnavailable(
      `Unsupported currency "${raw.currencyCode}" from Shopify. ` +
        `Add it to CurrencyCode in @nailzify/core before selling in this market.`,
    );
  }
  // Parsed from the decimal STRING, never via a float — see money.ts.
  return fromDecimalString(raw.amount, raw.currencyCode as CurrencyCode);
}
