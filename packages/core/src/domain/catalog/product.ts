/**
 * The catalog domain — and the most important file in this package.
 *
 * ============================================================================
 * THE TWO-PLANE RULE, ENFORCED BY THE TYPE SYSTEM
 * ============================================================================
 *
 * docs/01-architecture.md says: vectors shortlist products, Shopify supplies the
 * facts. That is stated as an architectural rule. A rule that lives only in prose
 * decays — six months from now someone in a hurry adds a `price` field to the
 * cache "for performance" and the whole guarantee quietly dies.
 *
 * So we encode it in the types instead. There are two representations:
 *
 *   ProductCandidate  ← comes out of vector search. An id and a score. NO PRICE.
 *   Product           ← comes out of Shopify, this request. HAS price + stock.
 *
 * And the recommendation function accepts only `Product[]`. That means:
 *
 *     recommend(candidates)   // ❌ does not compile — candidates have no price
 *     recommend(hydrated)     // ✅ compiles — hydration already happened
 *
 * You cannot forget to hydrate, because forgetting doesn't type-check. The
 * architecture is no longer a convention someone has to remember; it's a
 * compile error someone has to argue with.
 *
 * This is the "make illegal states unrepresentable" idea. It's the highest-value
 * thing a type system does, and it's worth reaching for whenever a rule is
 * important enough that you'd be upset if it were broken.
 */

import type { ProductHandle, ProductId } from "../shared/brand.js";
import type { Money, PriceBand } from "../shared/money.js";

// ---------------------------------------------------------------------------
// Descriptive attributes — stable enough to embed
// ---------------------------------------------------------------------------

/**
 * ⚠️ THESE ENUMS MATCH THE REAL CATALOGUE, not a plausible-sounding vocabulary.
 *
 * An earlier version was invented before anyone looked at the store. Probing the
 * live metafields showed how far off it was:
 *
 *   shape   invented stiletto and squoval, which the store does not sell
 *   finish  invented "glossy" (the store says "Gloss"), omitted "Metallic",
 *           and listed "chrome" as a finish when it is actually a nail TYPE
 *   length  had four members and there is no length metafield at all
 *
 * Every one of those mismatches would parse a real product to null and quietly
 * remove it from filtered search. Enum members are a data question, not a design
 * question — re-derive them with scripts/probe-metafields.ts when the catalogue
 * changes.
 */
export type NailShape = "almond" | "square" | "coffin" | "oval";

/**
 * Length has NO metafield. It is only ever inferred from a shape value that
 * smuggles it in ("Short Almond"), which is true for 2 of 40 products — so this
 * is null almost always, and that is honest rather than a gap to paper over.
 */
export type NailLength = "short" | "medium" | "long";

/** From `shopify.finish`. Set on 15/40 products. */
export type NailFinish = "gloss" | "matte" | "metallic";

/**
 * Occasion is NOT stored on the store. It is inferred, so treat it as a weak
 * signal rather than a fact — see attributes.ts.
 */
export type Occasion = "everyday" | "bridal" | "party" | "professional" | "holiday";

/**
 * Experience level a set is suited to. Press-ons with extreme length or intricate
 * application are genuinely harder for a first-timer, and the customer asked for
 * this to be part of the recommendation logic.
 */
export type ExperienceLevel = "beginner" | "comfortable" | "experienced";

/**
 * Descriptive attributes.
 *
 * ⚠️ shape/length/finish are NULLABLE, and that is load-bearing.
 *
 * An earlier version defaulted an untagged product to almond/medium/glossy. A
 * live catalogue check found 0 of 40 products tagged — so every one was being
 * described to the model with three fabricated facts, which it would then state
 * to a customer as truth. That is precisely the hallucination this architecture
 * exists to prevent, introduced by our own adapter rather than by a stale vector
 * or by the model.
 *
 * The catalogue also contains items like "Nail Remover", where nail shape is not
 * merely unknown but inapplicable. `null` says "we do not know"; a default says
 * "it is almond". Only one of those is honest.
 */
export interface ProductAttributes {
  readonly shape: NailShape | null;
  readonly length: NailLength | null;
  readonly finish: NailFinish | null;
  readonly occasions: readonly Occasion[];
  readonly suitableFor: readonly ExperienceLevel[];
  /** From `shopify.color-pattern`, e.g. ["Pink"], ["Floral"]. */
  readonly colourNotes: readonly string[];
  /**
   * Decorative style, from `custom.nail_type` — "Chrome", "French", "Cat-eye".
   *
   * DELIBERATELY FREE TEXT, not an enum. The real catalogue has 18 values with
   * genuine inconsistency ("3D Cat-eye" and "Cat-eye 3D" are the same thing),
   * so an enum would reject valid data on a spelling difference.
   *
   * It is also the dimension customers actually search by, and semantic search
   * handles the variants for free. Strict enums earn their place where the
   * vocabulary is small and clean (shape, finish); this one is neither.
   */
  readonly style: string | null;
}

// ---------------------------------------------------------------------------
// PLANE 1 — the semantic index. Relevance only.
// ---------------------------------------------------------------------------

/**
 * A product the vector index thinks is relevant.
 *
 * Note what is absent: price, stock, image, URL. Those are not "omitted for
 * brevity" — they are structurally unavailable, because a vector was written at
 * ingest time and cannot know today's truth.
 *
 * `priceBand` is here and an exact price is not, on purpose. See money.ts.
 */
export interface ProductCandidate {
  readonly productId: ProductId;
  /** Cosine similarity from the vector store, 0..1. */
  readonly score: number;
  readonly priceBand: PriceBand;
  readonly attributes: ProductAttributes;
}

// ---------------------------------------------------------------------------
// PLANE 2 — the live catalog. Facts.
// ---------------------------------------------------------------------------

export interface ProductVariant {
  readonly title: string;
  readonly price: Money;
  readonly available: boolean;
  /** Null when Shopify does not track inventory for this variant. */
  readonly quantityAvailable: number | null;
}

/**
 * A product as Shopify reports it, in THIS request.
 *
 * Every field here is safe to show a customer, because every field was fetched
 * moments ago from the system of record. This is the only type in the codebase
 * that carries a price.
 */
export interface Product {
  readonly id: ProductId;
  readonly handle: ProductHandle;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly price: Money;
  readonly available: boolean;
  readonly variants: readonly ProductVariant[];
  readonly attributes: ProductAttributes;
  /**
   * When this was read from Shopify. Present so a stale hydration can be
   * detected rather than trusted — freshness should be checkable, not assumed.
   */
  readonly fetchedAt: number;
}

/**
 * Display metadata safe to cache in DynamoDB.
 *
 * Deliberately NOT `Omit<Product, "price">`. Writing it out means adding a price
 * field later requires a conscious edit to a type whose doc comment says not to,
 * rather than happening automatically because someone widened `Product`.
 *
 * Cheap insurance against a future refactor silently reintroducing the bug.
 */
export interface CachedProductMetadata {
  readonly id: ProductId;
  readonly handle: ProductHandle;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly url: string;
  readonly priceBand: PriceBand;
  readonly attributes: ProductAttributes;
  readonly lastSyncedAt: number;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * The result of turning candidates into live products.
 *
 * `missing` is not an error case. A candidate disappearing is the system working
 * correctly: the product was deleted or unpublished in Shopify since the last
 * sync, and a stale vector must not be able to resurrect it. We surface the count
 * so ingestion drift is observable (docs/10-operations.md §10.3).
 */
export interface HydrationResult {
  readonly products: readonly Product[];
  readonly missing: readonly ProductId[];
}

/**
 * Join candidates to live products, preserving the semantic ranking.
 *
 * WHY PRESERVE ORDER: the vector store ranked these by relevance to what the
 * customer asked. Shopify returns them in whatever order it likes. Losing the
 * ranking would silently degrade recommendation quality with no visible symptom.
 */
export function hydrate(
  candidates: readonly ProductCandidate[],
  fetched: readonly Product[],
): HydrationResult {
  const byId = new Map(fetched.map((p) => [p.id, p]));
  const products: Product[] = [];
  const missing: ProductId[] = [];

  for (const candidate of candidates) {
    const product = byId.get(candidate.productId);
    if (product) products.push(product);
    else missing.push(candidate.productId);
  }

  return { products, missing };
}

// ---------------------------------------------------------------------------
// Vector metadata — one definition, used by both the writer and the readers
// ---------------------------------------------------------------------------

/**
 * Build the metadata stored alongside a product vector.
 *
 * WHY THIS EXISTS IN CORE. `VectorRecord.metadata` is `Record<string, unknown>`,
 * because a vector store genuinely accepts arbitrary keys. That means nothing
 * makes the writer and the reader agree: ingestion could write `nailShape` while
 * search reads `shape`, and the result is not a crash — it is every product
 * silently losing an attribute, and a bot that quietly stops being able to find
 * anything by shape. No test fails. Nobody notices until a customer does.
 *
 * Adding `style` to ProductAttributes is exactly that hazard: the reader was
 * updated in two adapters, and the writer did not exist yet to be updated.
 *
 * So the mapping lives here, once, and both sides go through it.
 *
 * ⚠️ NOTE WHAT IS ABSENT: no price, no stock. Only the stable descriptive facts
 * a vector is allowed to encode — the two-plane rule at the storage boundary.
 * `priceBand` is a coarse bucket, not a price; see money.ts.
 */
export function productVectorMetadata(input: {
  readonly productId: ProductId;
  readonly priceBand: PriceBand;
  readonly attributes: ProductAttributes;
}): Record<string, unknown> {
  const a = input.attributes;
  return {
    productId: input.productId,
    priceBand: input.priceBand,
    // Nulls are omitted rather than written as "". An absent key and an empty
    // string read back identically here, and omitting keeps stores that charge
    // for metadata size honest.
    ...(a.shape ? { shape: a.shape } : {}),
    ...(a.length ? { length: a.length } : {}),
    ...(a.finish ? { finish: a.finish } : {}),
    ...(a.style ? { style: a.style } : {}),
    occasions: [...a.occasions],
    suitableFor: [...a.suitableFor],
    colourNotes: [...a.colourNotes],
  };
}

/**
 * Inverse of `productVectorMetadata`. The pair is the contract.
 *
 * `read` is supplied by the caller because each store hands back a slightly
 * different value soup (Pinecone stringifies, the in-memory store does not).
 * The KEY NAMES stay here, which is the part that has to match.
 */
export function productAttributesFromMetadata(read: {
  str: (key: string) => string;
  strArray: (key: string) => string[];
}): ProductAttributes {
  return {
    shape: (read.str("shape") || null) as NailShape | null,
    length: (read.str("length") || null) as NailLength | null,
    finish: (read.str("finish") || null) as NailFinish | null,
    style: read.str("style") || null,
    occasions: read.strArray("occasions") as Occasion[],
    suitableFor: read.strArray("suitableFor") as ExperienceLevel[],
    colourNotes: read.strArray("colourNotes"),
  };
}
