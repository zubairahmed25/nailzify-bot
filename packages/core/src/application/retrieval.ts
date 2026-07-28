/**
 * Retrieval use cases — the two planes, executed.
 *
 * These orchestrate ports and contain no vendor code. That is what makes the
 * whole retrieval path testable in milliseconds against fakes, which in turn is
 * what makes the eval suite (docs/07-backend.md §7.8) practical to run per-PR.
 */

import type {
  Embedder,
  ProductCatalog,
  Reranker,
  VectorStore,
} from "../ports/index.js";
import {
  applyRetrievalPolicy,
  DEFAULT_RETRIEVAL_POLICY,
  type RetrievalOutcome,
  type RetrievalPolicy,
} from "../domain/knowledge/retrieval-policy.js";
import type { DocType } from "../domain/knowledge/chunk.js";
import { hydrate, type Product } from "../domain/catalog/product.js";
import {
  selectRecommendations,
  type CustomerPreferences,
  type Recommendation,
} from "../domain/catalog/recommendation.js";
import { bandsAtOrBelow, money, type CurrencyCode } from "../domain/shared/money.js";

export interface RetrievalDeps {
  readonly embedder: Embedder;
  readonly vectors: VectorStore;
  readonly reranker: Reranker;
  readonly catalog: ProductCatalog;
  readonly policy?: RetrievalPolicy;
  /** Currency the store prices in. Used to interpret budget ceilings. */
  readonly currency?: CurrencyCode;
  /**
   * How many candidates to pull before reranking.
   *
   * Retrieve wide, rerank, cut hard. Setting this generously costs little (the
   * vector search is ~50ms) and gives the cross-encoder something to work with.
   * Reranking is what makes correct abstention possible at all — see the
   * measured score distributions in retrieval-policy.ts.
   */
  readonly candidateCount?: number;
}

// ---------------------------------------------------------------------------
// Knowledge plane
// ---------------------------------------------------------------------------

export interface KnowledgeQuery {
  readonly query: string;
  readonly docType?: DocType;
}

/**
 * Search company documents.
 *
 * Returns a `RetrievalOutcome` — a discriminated union, not an array — so the
 * caller cannot accidentally skip the abstention case. Vector search always
 * returns something; whether it found the ANSWER is a separate question.
 */
export async function searchKnowledge(
  deps: RetrievalDeps,
  input: KnowledgeQuery,
): Promise<RetrievalOutcome> {
  const policy = deps.policy ?? DEFAULT_RETRIEVAL_POLICY;
  const topK = deps.candidateCount ?? 20;

  // `"query"`, not `"document"`. Getting this backwards silently degrades
  // retrieval with no error — see the Embedder port.
  const vector = await deps.embedder.embed(input.query, "query");

  const candidates = await deps.vectors.searchKnowledge(
    vector,
    topK,
    input.docType ? { docType: input.docType } : undefined,
  );

  if (candidates.length === 0) return { kind: "insufficient", bestScore: null };

  // Reranking may throw (its on-demand throughput is tight — measured: throttled
  // after three sequential calls). Degrade to cosine ordering rather than
  // failing the turn; the policy applies the cosine floor when no rerank score
  // is present, so the abstention decision stays coherent either way.
  let scored = candidates;
  try {
    scored = await deps.reranker.rerank(input.query, candidates, policy.maxChunks);
  } catch {
    scored = candidates.slice(0, policy.maxChunks);
  }

  return applyRetrievalPolicy(scored, policy);
}

// ---------------------------------------------------------------------------
// Catalog plane
// ---------------------------------------------------------------------------

export interface ProductQuery {
  readonly query: string;
  readonly preferences: CustomerPreferences;
}

export interface ProductSearchResult {
  readonly recommendations: readonly Recommendation[];
  /** Candidates whose products no longer exist in Shopify. Drift signal. */
  readonly missingCount: number;
  /** True when candidates were found but every one was out of stock. */
  readonly allOutOfStock: boolean;
}

/**
 * Find products.
 *
 * The two-plane rule executed end to end:
 *
 *   1. embed the query
 *   2. vector search -> ProductCandidate[]   (ids + scores, NO PRICE)
 *   3. hydrate from Shopify -> Product[]     (live price + stock)
 *   4. rank and filter on live truth
 *
 * Step 3 is not optional and cannot be skipped: `selectRecommendations` accepts
 * `Product[]`, and candidates do not typecheck as products.
 */
export async function searchProducts(
  deps: RetrievalDeps,
  input: ProductQuery,
): Promise<ProductSearchResult> {
  const { preferences } = input;
  const vector = await deps.embedder.embed(input.query, "query");

  const candidates = await deps.vectors.searchProducts(vector, deps.candidateCount ?? 12, {
    ...(preferences.shape ? { shape: preferences.shape } : {}),
    ...(preferences.length ? { length: preferences.length } : {}),
    ...(preferences.occasion ? { occasion: preferences.occasion } : {}),
    // A coarse band pre-filter, not a price check. The exact price still comes
    // from the live hydration below.
    ...(preferences.maxPrice ? { priceBands: bandsAtOrBelow(preferences.maxPrice) } : {}),
  });

  if (candidates.length === 0) {
    return { recommendations: [], missingCount: 0, allOutOfStock: false };
  }

  const fetched = await deps.catalog.getByIds(candidates.map((c) => c.productId));
  const { products, missing } = hydrate(candidates, fetched);

  const recommendations = selectRecommendations(products, preferences, 4);

  return {
    recommendations,
    missingCount: missing.length,
    // Distinguishing "nothing matched" from "everything matched but is sold out"
    // matters: the second deserves a different answer to the customer.
    allOutOfStock: products.length > 0 && products.every((p) => !p.available),
  };
}

/** Build domain preferences from loosely-typed tool arguments. */
export function toPreferences(
  args: Readonly<Record<string, unknown>>,
  currency: CurrencyCode = "USD",
): CustomerPreferences {
  const str = <T extends string>(key: string): T | undefined =>
    typeof args[key] === "string" ? (args[key] as T) : undefined;

  const maxPriceMinor = args["maxPriceMinor"];
  const styleNotes = args["styleNotes"];

  return {
    ...(str("shape") ? { shape: str<CustomerPreferences["shape"] & string>("shape")! } : {}),
    ...(str("length") ? { length: str<CustomerPreferences["length"] & string>("length")! } : {}),
    ...(str("occasion")
      ? { occasion: str<CustomerPreferences["occasion"] & string>("occasion")! }
      : {}),
    ...(str("experience")
      ? { experience: str<CustomerPreferences["experience"] & string>("experience")! }
      : {}),
    ...(typeof maxPriceMinor === "number" && Number.isInteger(maxPriceMinor) && maxPriceMinor > 0
      ? { maxPrice: money(maxPriceMinor, currency) }
      : {}),
    ...(Array.isArray(styleNotes)
      ? { styleNotes: styleNotes.filter((s): s is string => typeof s === "string") }
      : {}),
  };
}

/** Fetch one product live. Null when the handle does not resolve. */
export async function getProductDetails(
  deps: RetrievalDeps,
  handle: string,
): Promise<Product | null> {
  return deps.catalog.getByHandle(handle as Product["handle"]);
}
