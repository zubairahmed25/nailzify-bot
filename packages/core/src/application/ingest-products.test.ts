import { describe, expect, it } from "vitest";
import { ProductHandle, ProductId } from "../domain/shared/brand.js";
import { money } from "../domain/shared/money.js";
import type { Product, ProductAttributes } from "../domain/catalog/product.js";
import type { Embedder, Page, ProductCatalog, VectorStore } from "../ports/index.js";
import { EmptyCatalogError, ingestProducts } from "./ingest-products.js";

const attrs = (over: Partial<ProductAttributes> = {}): ProductAttributes => ({
  kind: "nail-set",
  shape: "almond",
  length: "short",
  finishes: ["matte"],
  style: "Chrome",
  occasions: ["everyday"],
  suitableFor: ["comfortable"],
  colourNotes: ["Pink"],
  ...over,
});

const product = (id: string, over: Partial<Product> = {}): Product => ({
  id: ProductId(id),
  handle: ProductHandle(id),
  title: `Product ${id}`,
  description: "A warm, muted set.",
  productType: "",
  url: `https://nailzify.com/products/${id}`,
  imageUrl: null,
  price: money(1399, "USD"),
  available: true,
  variants: [],
  attributes: attrs(),
  fetchedAt: 0,
  ...over,
});

function deps(pages: Page<Product>[]) {
  const upserted: { id: string; metadata: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const embeddedTexts: string[] = [];
  let pageIndex = 0;

  const catalog: ProductCatalog = {
    getByIds: async () => [],
    getByHandle: async () => null,
    listAll: async () => pages[pageIndex++] ?? { items: [], cursor: null },
  };

  const embedder: Embedder = {
    embed: async () => [1, 0, 0],
    embedBatch: async (texts) => {
      embeddedTexts.push(...texts);
      return texts.map(() => [1, 0, 0]);
    },
    dimensions: 3,
    modelId: "cohere.embed-v4:0",
  };

  const vectors: VectorStore = {
    upsert: async (_ns, records) => {
      upserted.push(...records.map((r) => ({ id: r.id, metadata: r.metadata })));
    },
    searchKnowledge: async () => [],
    searchProducts: async () => [],
    deleteByDocument: async (_ns, id) => {
      deleted.push(id);
    },
  };

  return { catalog, embedder, vectors, upserted, deleted, embeddedTexts };
}

const onePage = (items: Product[]): Page<Product>[] => [{ items, cursor: null }];

// ---------------------------------------------------------------------------
// The two-plane rule, enforced at the write side
// ---------------------------------------------------------------------------

describe("nothing volatile reaches the index", () => {
  it("puts no price in the embedded text", async () => {
    // An index is a cache with no invalidation. Embed "$13.99" today and the bot
    // quotes it next month from a vector nobody thought to refresh.
    const d = deps(onePage([product("1", { price: money(1399, "USD") })]));

    await ingestProducts(d);

    expect(d.embeddedTexts.join(" ")).not.toMatch(/13\.99|\$|USD/);
  });

  it("puts no price or stock in the vector metadata", async () => {
    const d = deps(onePage([product("1", { available: false })]));

    await ingestProducts(d);

    const metadata = d.upserted[0]!.metadata;
    expect(Object.keys(metadata)).not.toContain("price");
    expect(Object.keys(metadata)).not.toContain("available");
    expect(JSON.stringify(metadata)).not.toMatch(/\d+\.\d{2}/);
  });

  it("indexes out-of-stock products anyway", async () => {
    // Stock is a request-time fact. Skipping sold-out products at index time
    // would mean a restocked item stays invisible until the next reindex.
    const d = deps(onePage([product("1", { available: false })]));

    expect((await ingestProducts(d)).productsIndexed).toBe(1);
  });

  it("stores a coarse price band for filtering", async () => {
    // A band survives a price change within its range and is only used to
    // narrow candidates — the exact price still comes from Shopify.
    const d = deps(onePage([product("1", { price: money(1399, "USD") })]));

    await ingestProducts(d);

    expect(d.upserted[0]!.metadata["priceBand"]).toBe("under-15");
  });
});

// ---------------------------------------------------------------------------

describe("failure must never empty the index", () => {
  it("refuses an empty catalogue", async () => {
    // Far more likely to be a failed request than a shop with nothing in it.
    const d = deps(onePage([]));

    await expect(ingestProducts(d)).rejects.toBeInstanceOf(EmptyCatalogError);
    expect(d.upserted).toEqual([]);
    expect(d.deleted).toEqual([]);
  });

  it("refuses when the embedder returns misaligned vectors", async () => {
    const d = deps(onePage([product("1"), product("2")]));

    await expect(
      ingestProducts({ ...d, embedder: { ...d.embedder, embedBatch: async () => [[1, 0, 0]] } }),
    ).rejects.toThrow(/vectors for 2 products/);
    expect(d.upserted).toEqual([]);
  });

  it("stops rather than looping when the cursor never advances", async () => {
    const stuck: ProductCatalog = {
      getByIds: async () => [],
      getByHandle: async () => null,
      listAll: async () => ({ items: [product("1")], cursor: "always-more" }),
    };
    const d = deps([]);

    await expect(ingestProducts({ ...d, catalog: stuck })).rejects.toThrow(/refusing to loop/i);
  });
});

// ---------------------------------------------------------------------------

describe("keeping the index in step with Shopify", () => {
  it("pages through the whole catalogue", async () => {
    const d = deps([
      { items: [product("1"), product("2")], cursor: "next" },
      { items: [product("3")], cursor: null },
    ]);

    expect((await ingestProducts(d)).productsIndexed).toBe(3);
    expect(d.upserted).toHaveLength(3);
  });

  it("removes products Shopify no longer returns", async () => {
    // A stale vector is worse than a missing one: it surfaces in search, then
    // vanishes at hydration, so the bot says it found something and shows nothing.
    const d = deps(onePage([product("live")]));

    const report = await ingestProducts(d, [ProductId("live"), ProductId("deleted")]);

    expect(report.removed).toEqual([ProductId("deleted")]);
    expect(d.deleted).toEqual(["deleted"]);
  });

  it("removes nothing when every known product is still live", async () => {
    const d = deps(onePage([product("a"), product("b")]));

    const report = await ingestProducts(d, [ProductId("a"), ProductId("b")]);

    expect(report.removed).toEqual([]);
    expect(d.deleted).toEqual([]);
  });

  it("returns the indexed ids so the caller need not refetch the catalogue", async () => {
    // The alternative is a second full listing, which costs a round trip over
    // the whole catalogue and can disagree with the one just ingested.
    const d = deps(onePage([product("a"), product("b")]));

    const report = await ingestProducts(d);

    expect(report.indexedIds).toEqual([ProductId("a"), ProductId("b")]);
  });

  it("skips deletion detection when given no prior state", async () => {
    const d = deps(onePage([product("1")]));

    expect((await ingestProducts(d)).removed).toEqual([]);
    expect(d.deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("what the vectors describe", () => {
  it("indexes accessories too, and reports how many", async () => {
    // "Do you sell nail glue?" is a real question. Excluding accessories from
    // the index would make it unanswerable.
    const d = deps(
      onePage([
        product("nails", { attributes: attrs() }),
        product("glue", {
          title: "Semi-Solid Glue",
          attributes: attrs({
            kind: "accessory",
            shape: null,
            length: null,
            finishes: [],
            style: null,
            occasions: [],
            suitableFor: [],
            colourNotes: [],
          }),
        }),
      ]),
    );

    const report = await ingestProducts(d);

    expect(report.productsIndexed).toBe(2);
    expect(report.accessoriesIndexed).toBe(1);
    expect(d.upserted.map((r) => r.metadata["kind"])).toEqual(["nail-set", "accessory"]);
  });

  it("embeds style, the attribute customers actually search by", async () => {
    const d = deps(onePage([product("1", { attributes: attrs({ style: "3D Cat-eye" }) })]));

    await ingestProducts(d);

    expect(d.embeddedTexts[0]).toContain("3D Cat-eye");
  });

  it("omits attributes the product does not have", async () => {
    const d = deps(
      onePage([product("1", { attributes: attrs({ shape: null, style: null, finishes: [] }) })]),
    );

    await ingestProducts(d);

    expect(d.embeddedTexts[0]).not.toContain("Shape:");
    expect(d.embeddedTexts[0]).not.toContain("Finish:");
    expect(d.upserted[0]!.metadata).not.toHaveProperty("shape");
  });

  it("batches embedding calls", async () => {
    const many = Array.from({ length: 40 }, (_, i) => product(`p${i}`));
    const d = deps(onePage(many));

    const report = await ingestProducts({ ...d, batchSize: 16 });

    expect(report.embeddingCalls).toBe(3);
    expect(report.productsIndexed).toBe(40);
  });
});
