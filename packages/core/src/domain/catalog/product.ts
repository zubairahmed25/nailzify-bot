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

export type NailShape = "almond" | "coffin" | "square" | "stiletto" | "oval" | "squoval";
export type NailLength = "short" | "medium" | "long" | "extra-long";
export type NailFinish = "matte" | "glossy" | "glitter" | "chrome" | "textured";
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
  /** Free-text colour descriptors, e.g. ["warm nude", "terracotta"]. */
  readonly colourNotes: readonly string[];
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
