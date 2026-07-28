import { describe, expect, it, vi } from "vitest";
import { CatalogUnavailable, ProductId, formatMoney, hydrate } from "@nailzify/core";
import type { ProductCandidate } from "@nailzify/core";
import { createShopifyProductCatalog } from "./product-catalog.js";
import { createStorefrontClient } from "./storefront-client.js";

// ---------------------------------------------------------------------------
// Fixtures modelled on the verified Storefront API schema
// ---------------------------------------------------------------------------

function rawProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Product/8123",
    handle: "autumn-almond-short",
    title: "Autumn Almond — Short",
    description: "A warm, muted set.",
    productType: "Press-on Nails",
    tags: ["shape:almond", "length:short", "finish:matte", "occasion:everyday"],
    availableForSale: true,
    onlineStoreUrl: "https://nailzify.com/products/autumn-almond-short",
    featuredImage: { url: "https://cdn.shopify.com/img.jpg" },
    priceRange: { minVariantPrice: { amount: "18.00", currencyCode: "USD" } },
    // Both live value shapes: custom.* are plain strings, shopify.* are
    // taxonomy metaobject references whose label only exists once resolved.
    metafields: [
      { namespace: "custom", key: "nail_text", value: "Short Almond", references: null },
      { namespace: "custom", key: "nail_type", value: "Chrome", references: null },
      {
        namespace: "shopify",
        key: "color-pattern",
        value: '["gid://shopify/Metaobject/100210"]',
        references: { nodes: [{ field: { value: "Pink" } }] },
      },
      {
        namespace: "shopify",
        key: "finish",
        value: '["gid://shopify/Metaobject/100455"]',
        references: { nodes: [{ field: { value: "Matte" } }] },
      },
    ],
    variants: {
      nodes: [
        {
          title: "Default",
          availableForSale: true,
          quantityAvailable: 12,
          price: { amount: "18.00", currencyCode: "USD" },
        },
      ],
    },
    ...overrides,
  };
}

/** A fake `fetch` that returns one canned GraphQL body. */
function fakeFetch(body: unknown, init: { status?: number } = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function catalogWith(body: unknown, init: { status?: number } = {}) {
  const fetchImpl = fakeFetch(body, init);
  const client = createStorefrontClient({
    shopDomain: "nailzify.myshopify.com",
    accessToken: "test-token",
    apiVersion: "2025-01",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return {
    catalog: createShopifyProductCatalog({
      client,
      storefrontDomain: "nailzify.com",
    }),
    fetchImpl,
  };
}

// ---------------------------------------------------------------------------

describe("hydration", () => {
  it("maps a product with a correctly parsed price", async () => {
    const { catalog } = catalogWith({ data: { nodes: [rawProduct()] } });

    const [product] = await catalog.getByIds([ProductId("gid://shopify/Product/8123")]);

    expect(product!.title).toBe("Autumn Almond — Short");
    // Parsed from the decimal STRING via integer minor units — never a float.
    expect(product!.price.amountMinor).toBe(1800);
    expect(formatMoney(product!.price)).toBe("$18.00");
    expect(product!.attributes.shape).toBe("almond");
  });

  it("drops null entries for products that no longer resolve", async () => {
    // `nodes(ids:)` returns null for a deleted or unpublished product. Dropping
    // it is CORRECT — a stale vector must not resurrect a dead product.
    const { catalog } = catalogWith({ data: { nodes: [rawProduct(), null] } });

    const products = await catalog.getByIds([
      ProductId("gid://shopify/Product/8123"),
      ProductId("gid://shopify/Product/9999"),
    ]);

    expect(products).toHaveLength(1);
  });

  it("batches into one request rather than N", async () => {
    // Hydration is in the chat request path. N round trips is the difference
    // between a ~120ms hop and a timeout.
    const { catalog, fetchImpl } = catalogWith({ data: { nodes: [rawProduct()] } });

    await catalog.getByIds([
      ProductId("gid://shopify/Product/1"),
      ProductId("gid://shopify/Product/2"),
      ProductId("gid://shopify/Product/3"),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("makes no request at all for an empty id list", async () => {
    const { catalog, fetchImpl } = catalogWith({ data: { nodes: [] } });

    expect(await catalog.getByIds([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stamps fetchedAt so freshness is checkable rather than assumed", async () => {
    const before = Date.now();
    const { catalog } = catalogWith({ data: { nodes: [rawProduct()] } });

    const [product] = await catalog.getByIds([ProductId("gid://shopify/Product/8123")]);

    expect(product!.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("verified schema nullability", () => {
  it("falls back to a constructed URL when onlineStoreUrl is null", async () => {
    // onlineStoreUrl is NULL for products not published to the Online Store
    // channel. Sending a customer to "null" is worse than a constructed link.
    const { catalog } = catalogWith({
      data: { nodes: [rawProduct({ onlineStoreUrl: null })] },
    });

    const [product] = await catalog.getByIds([ProductId("gid://shopify/Product/8123")]);

    expect(product!.url).toBe("https://nailzify.com/products/autumn-almond-short");
  });

  it("tolerates a null quantityAvailable", async () => {
    // The field requires extra token access. The bot must work on the minimal
    // scope, so availableForSale carries the in-stock decision.
    const { catalog } = catalogWith({
      data: {
        nodes: [
          rawProduct({
            variants: {
              nodes: [
                {
                  title: "Default",
                  availableForSale: true,
                  quantityAvailable: null,
                  price: { amount: "18.00", currencyCode: "USD" },
                },
              ],
            },
          }),
        ],
      },
    });

    const [product] = await catalog.getByIds([ProductId("gid://shopify/Product/8123")]);

    expect(product!.variants[0]!.quantityAvailable).toBeNull();
    expect(product!.variants[0]!.available).toBe(true);
    expect(product!.available).toBe(true);
  });

  it("tolerates a null featuredImage", async () => {
    const { catalog } = catalogWith({
      data: { nodes: [rawProduct({ featuredImage: null })] },
    });

    const [product] = await catalog.getByIds([ProductId("gid://shopify/Product/8123")]);
    expect(product!.imageUrl).toBeNull();
  });
});

describe("error handling", () => {
  it("throws on a GraphQL error returned with HTTP 200", async () => {
    // ⚠️ GraphQL returns 200 on errors. A client checking only `response.ok`
    // treats a failed query as success and returns an empty product list —
    // which the bot reports to a customer as "we don't sell that".
    const { catalog } = catalogWith({
      errors: [{ message: "Field 'bogus' doesn't exist on type 'Product'" }],
    });

    await expect(
      catalog.getByIds([ProductId("gid://shopify/Product/8123")]),
    ).rejects.toBeInstanceOf(CatalogUnavailable);
  });

  it("throws on a non-2xx response", async () => {
    const { catalog } = catalogWith({ data: null }, { status: 430 });

    await expect(
      catalog.getByIds([ProductId("gid://shopify/Product/8123")]),
    ).rejects.toBeInstanceOf(CatalogUnavailable);
  });

  it("refuses to coerce an unsupported currency", async () => {
    // Silently defaulting to USD would show a customer a number wrong by an
    // exchange rate — precisely the class of error this design prevents.
    const { catalog } = catalogWith({
      data: {
        nodes: [
          rawProduct({
            priceRange: { minVariantPrice: { amount: "1800", currencyCode: "JPY" } },
          }),
        ],
      },
    });

    await expect(
      catalog.getByIds([ProductId("gid://shopify/Product/8123")]),
    ).rejects.toThrow(/Unsupported currency "JPY"/);
  });

  it("marks catalog failures retryable so callers can back off", async () => {
    const { catalog } = catalogWith({ errors: [{ message: "throttled" }] });

    await catalog.getByIds([ProductId("gid://shopify/Product/1")]).catch((e: unknown) => {
      expect((e as CatalogUnavailable).retryable).toBe(true);
    });
  });
});

describe("the two planes joined", () => {
  it("turns candidates into priced products, preserving semantic rank", async () => {
    // THE FULL LOOP. Vector search produced ids and scores with no price; the
    // catalog supplied the price. Neither half can do the other's job.
    const candidates: ProductCandidate[] = [
      {
        productId: ProductId("gid://shopify/Product/8123"),
        score: 0.81,
        priceBand: "15-25",
        attributes: {
          kind: "nail-set",
          shape: "almond",
          length: "short",
          finishes: ["matte"],
          occasions: ["everyday"],
          suitableFor: ["beginner"],
          colourNotes: [],
          style: null,
        },
      },
      {
        productId: ProductId("gid://shopify/Product/9999"),
        score: 0.79,
        priceBand: "15-25",
        attributes: {
          kind: "nail-set",
          shape: "almond",
          length: "short",
          finishes: ["matte"],
          occasions: ["everyday"],
          suitableFor: ["beginner"],
          colourNotes: [],
          style: null,
        },
      },
    ];

    const { catalog } = catalogWith({ data: { nodes: [rawProduct(), null] } });
    const fetched = await catalog.getByIds(candidates.map((c) => c.productId));
    const { products, missing } = hydrate(candidates, fetched);

    expect(products).toHaveLength(1);
    expect(products[0]!.price.amountMinor).toBe(1800);
    // The candidate that no longer exists is reported, not silently swallowed.
    expect(missing).toEqual([ProductId("gid://shopify/Product/9999")]);
  });
});

describe("merchandising warnings", () => {
  it("surfaces metafield problems to the caller", async () => {
    const warnings: string[] = [];
    const fetchImpl = fakeFetch({
      data: {
        nodes: [
          rawProduct({
            metafields: [
              { namespace: "custom", key: "nail_text", value: "Almnod", references: null },
            ],
          }),
        ],
      },
    });
    const client = createStorefrontClient({
      shopDomain: "nailzify.myshopify.com",
      accessToken: "t",
      apiVersion: "2025-01",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const catalog = createShopifyProductCatalog({
      client,
      storefrontDomain: "nailzify.com",
      onWarning: (w) => warnings.push(w),
    });

    await catalog.getByIds([ProductId("gid://shopify/Product/8123")]);

    // Echoed VERBATIM, not lowercased — the warning is only actionable if the
    // merchandiser can search the admin for the exact string it names.
    expect(warnings.some((w) => w.includes("Almnod"))).toBe(true);
  });
});
