/**
 * Indexing the product catalogue for semantic search.
 *
 * ============================================================================
 * WHAT GOES IN A PRODUCT VECTOR, AND WHAT MUST NEVER
 * ============================================================================
 *
 * This is the write side of the two-plane rule (docs/01-architecture.md). The
 * vector index holds STABLE DESCRIPTIVE FACTS — title, shape, style, colour —
 * and nothing that can change without the product being re-indexed.
 *
 * Specifically: no price, no stock level. Not because they are secret, but
 * because an index is a cache with no invalidation. Embed "$13.99" today and the
 * bot will quote $13.99 next month, confidently, from a vector nobody thought to
 * refresh. Prices come from Shopify at request time or they do not come at all.
 *
 * `productEmbeddingText` and `productVectorMetadata` both enforce this, and the
 * round-trip test asserts no price-shaped string survives into metadata.
 *
 * ============================================================================
 * WHY THIS ONE IS SAFE TO DO INCREMENTALLY AND KNOWLEDGE IS NOT
 * ============================================================================
 *
 * A document is replaced wholesale because its chunks have no independent
 * identity — chunk 4 of the return policy is meaningless on its own. Products
 * are the opposite: each has a stable Shopify id, so upserting one leaves the
 * other 39 untouched. There is no destructive step and therefore no window.
 *
 * The one thing that DOES need care is deletion. A product removed from Shopify
 * leaves a vector behind, and a stale vector is worse than a missing one — it
 * surfaces in search and then vanishes at hydration, so the bot says "I found
 * something" and then shows nothing. Handled below by diffing the full listing.
 */

import type { ProductId } from "../domain/shared/brand.js";
import { productEmbeddingText } from "../domain/catalog/embedding-text.js";
import { productVectorMetadata } from "../domain/catalog/product.js";
import { priceBandOf } from "../domain/shared/money.js";
import type { Product } from "../domain/catalog/product.js";
import type { Embedder, ProductCatalog, VectorStore } from "../ports/index.js";

export interface IngestProductsDeps {
  readonly catalog: ProductCatalog;
  readonly embedder: Embedder;
  readonly vectors: VectorStore;
  readonly batchSize?: number;
  readonly onProgress?: (event: ProductIngestProgress) => void;
}

export type ProductIngestProgress =
  | { readonly kind: "page"; readonly fetched: number; readonly total: number }
  | { readonly kind: "indexed"; readonly done: number; readonly total: number }
  | { readonly kind: "removed"; readonly productIds: readonly ProductId[] };

export interface ProductIngestReport {
  readonly productsIndexed: number;
  readonly accessoriesIndexed: number;
  readonly embeddingCalls: number;
  /** Products in the index that no longer exist in Shopify, now deleted. */
  readonly removed: readonly ProductId[];
  /**
   * Every id now in the index. Feed this back as `previouslyIndexed` next run.
   *
   * Returned rather than left to the caller because the caller's only other
   * option is a second full listing — a wasted round trip over the whole
   * catalogue that can also disagree with the one just ingested if a product
   * changed in between.
   */
  readonly indexedIds: readonly ProductId[];
}

// NOTE: no `warnings` field. Merchandising warnings are emitted by the Shopify
// adapter's `onWarning` callback, wired at construction in the composition root
// — they never pass through this function. A report field that is always empty
// reads as "no problems found" when it actually means "not measured here".

const DEFAULT_BATCH_SIZE = 64;

/** Guard against an unbounded loop if a catalogue keeps returning a cursor. */
const MAX_PAGES = 200;

export async function ingestProducts(
  deps: IngestProductsDeps,
  /**
   * Product ids currently in the index, for detecting deletions.
   *
   * Passed in rather than queried because vector stores have no cheap "list all
   * ids" operation — Pinecone's pagination over an entire namespace costs more
   * than tracking this in the ingestion job's own bookkeeping. Pass an empty
   * array to skip deletion detection.
   */
  previouslyIndexed: readonly ProductId[] = [],
): Promise<ProductIngestReport> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  // ---- 1. Fetch the whole catalogue ---------------------------------------
  const products: Product[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const page = await deps.catalog.listAll(cursor ?? undefined);
    products.push(...page.items);
    cursor = page.cursor;
    pages += 1;
    deps.onProgress?.({ kind: "page", fetched: products.length, total: products.length });

    if (pages >= MAX_PAGES) {
      throw new Error(
        `Product listing exceeded ${MAX_PAGES} pages. Either the catalogue grew ` +
          `enormously or the cursor is not advancing — refusing to loop forever.`,
      );
    }
  } while (cursor !== null);

  if (products.length === 0) {
    // Same reasoning as an empty document: an empty catalogue is far more likely
    // to be a failed API call than a shop with nothing in it. Deleting the index
    // on that basis would take the bot down because a request timed out.
    throw new EmptyCatalogError();
  }

  // ---- 2. Embed ------------------------------------------------------------
  const texts = products.map((p) =>
    productEmbeddingText({
      title: p.title,
      description: p.description,
      productType: p.productType,
      attributes: p.attributes,
    }),
  );

  const vectors: (readonly number[])[] = [];
  let embeddingCalls = 0;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embedded = await deps.embedder.embedBatch(batch, "document");
    embeddingCalls += 1;

    if (embedded.length !== batch.length) {
      throw new Error(
        `Embedder returned ${embedded.length} vectors for ${batch.length} products. ` +
          `Refusing to continue — misaligned vectors would attach each product's ` +
          `description to a different product's id.`,
      );
    }

    vectors.push(...embedded);
    deps.onProgress?.({
      kind: "indexed",
      done: Math.min(i + batchSize, texts.length),
      total: texts.length,
    });
  }

  // ---- 3. Upsert -----------------------------------------------------------
  await deps.vectors.upsert(
    "products",
    products.map((product, i) => ({
      id: product.id,
      values: vectors[i]!,
      metadata: productVectorMetadata({
        productId: product.id,
        priceBand: priceBandOf(product.price),
        attributes: product.attributes,
      }),
    })),
  );

  // ---- 4. Remove what Shopify no longer has --------------------------------
  const live = new Set<string>(products.map((p) => p.id));
  const removed = previouslyIndexed.filter((id) => !live.has(id));

  for (const id of removed) {
    // deleteByDocument is keyed by id in the products namespace — one vector per
    // product, so document and record coincide here.
    await deps.vectors.deleteByDocument("products", id);
  }
  if (removed.length > 0) deps.onProgress?.({ kind: "removed", productIds: removed });

  return {
    productsIndexed: products.length,
    accessoriesIndexed: products.filter((p) => p.attributes.kind === "accessory").length,
    embeddingCalls,
    removed,
    indexedIds: products.map((p) => p.id),
  };
}

export class EmptyCatalogError extends Error {
  constructor() {
    super(
      `Shopify returned zero products. Refusing to reindex — an empty catalogue is ` +
        `far more likely to be a failed request than a shop with nothing in it, and ` +
        `acting on it would empty the product index.`,
    );
    this.name = "EmptyCatalogError";
  }
}
