/**
 * Ports — the interfaces the outside world must implement.
 *
 * ============================================================================
 * WHY PORTS, IN ONE PARAGRAPH
 * ============================================================================
 *
 * Every interface here is narrow on purpose. `VectorStore` has three methods
 * because that is all the domain does with a vector store; Pinecone's SDK has
 * dozens. If we widened the port to match the SDK, we would have coupled to
 * Pinecone while appearing not to — and the migration to pgvector or S3 Vectors
 * (docs/02-aws-services.md §2.5) would be a rewrite instead of an adapter swap.
 *
 * THE TEST: could you implement this interface against a completely different
 * vendor without contorting it? If not, the abstraction has leaked.
 *
 * SECOND BENEFIT, EQUALLY VALUABLE: these are trivial to fake in a test. No
 * mocking framework, no LocalStack, no credentials — just an object literal.
 * That is what makes the domain test suite run in under two seconds.
 */

import type { ChunkId, CustomerId, ProductHandle, ProductId, SessionId } from "../domain/shared/brand.js";
import type { Message } from "../domain/conversation/message.js";
import type { Session } from "../domain/conversation/session.js";
import type { Chunk, DocType, ScoredChunk } from "../domain/knowledge/chunk.js";
import type { CachedProductMetadata, Product, ProductCandidate } from "../domain/catalog/product.js";
import type { PriceBand } from "../domain/shared/money.js";

// ===========================================================================
// Clock
// ===========================================================================

/**
 * Time, as a dependency.
 *
 * Calling `Date.now()` inside domain logic makes that logic untestable: you
 * cannot assert on TTL arithmetic or session expiry without either mocking
 * globals or sleeping. Injecting the clock turns "what happens after 31 days?"
 * into a one-line test.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** For tests. Advance it explicitly to simulate the passage of time. */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ===========================================================================
// LLM
// ===========================================================================

/**
 * Model roles, referenced by intent rather than by ID.
 *
 * The domain asks for "the fast model", not for `anthropic.claude-haiku-4-5`.
 * That keeps model routing (docs/10-operations.md §10.7 — the second-biggest cost
 * lever) a configuration decision rather than something hard-coded through the
 * call sites.
 */
export type ModelRole = "chat" | "fast" | "judge";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface LlmRequest {
  readonly model: ModelRole;
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxTokens: number;
  /**
   * Mark the system prompt + tool definitions as a cacheable prefix.
   *
   * On Bedrock this must be placed on a specific content block by the adapter —
   * there is no automatic top-level caching, and the minimum cacheable prefix is
   * model-dependent (~1024 tokens for Sonnet 5, ~4096 for Haiku 4.5). Below the
   * minimum nothing caches and NO ERROR is raised, so the adapter is responsible
   * for surfacing `cacheReadInputTokens` to make it observable.
   */
  readonly cacheSystemPrompt?: boolean;
  /** Thinking depth / token spend. Sweep it per route against your eval set. */
  readonly effort?: "low" | "medium" | "high";
}

export type LlmStreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: "done"; readonly stopReason: LlmStopReason; readonly usage: LlmUsage };

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly toolCalls: readonly { id: string; name: string; input: Readonly<Record<string, unknown>> }[];
  readonly stopReason: LlmStopReason;
  readonly usage: LlmUsage;
}

/** Implemented by the Bedrock adapter — or a Claude Platform on AWS one. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

// ===========================================================================
// Embeddings
// ===========================================================================

/**
 * Asymmetric embedding: documents and queries are embedded DIFFERENTLY.
 *
 * A question is short and interrogative; a policy chunk is long and declarative.
 * Telling the model which side it is embedding measurably improves matching.
 *
 * ⚠️ Getting this backwards silently degrades retrieval with no error, and it is
 * a genuinely common bug. It is a required parameter here precisely so a caller
 * cannot forget it (docs/03-ingestion.md §3.6).
 */
export type EmbeddingPurpose = "document" | "query";

export interface Embedder {
  embed(text: string, purpose: EmbeddingPurpose): Promise<readonly number[]>;
  /** Batched — Cohere accepts up to 96 per call. Same purpose for the whole batch. */
  embedBatch(texts: readonly string[], purpose: EmbeddingPurpose): Promise<readonly (readonly number[])[]>;
  /** Must match the vector index dimension exactly, or upserts fail. */
  readonly dimensions: number;
  readonly modelId: string;
}

// ===========================================================================
// Vector store
// ===========================================================================

/** Logical partitions inside one index. Keeps the two planes from mixing. */
export type Namespace = "knowledge" | "products";

export interface KnowledgeFilter {
  readonly docType?: DocType;
  readonly documentId?: string;
}

export interface ProductFilter {
  readonly shape?: string;
  readonly length?: string;
  readonly occasion?: string;
  readonly priceBands?: readonly PriceBand[];
}

export interface VectorRecord {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface VectorStore {
  upsert(namespace: Namespace, records: readonly VectorRecord[]): Promise<void>;

  searchKnowledge(
    vector: readonly number[],
    topK: number,
    filter?: KnowledgeFilter,
  ): Promise<readonly ScoredChunk[]>;

  /**
   * Returns CANDIDATES — ids, scores, and stable attributes. No price, no stock.
   *
   * The return type is the two-plane rule made unavoidable: a caller physically
   * cannot render a price from this, they must hydrate first. See
   * domain/catalog/product.ts.
   */
  searchProducts(
    vector: readonly number[],
    topK: number,
    filter?: ProductFilter,
  ): Promise<readonly ProductCandidate[]>;

  /** Used when a document is updated or deleted. Keyed so re-ingest is surgical. */
  deleteByDocument(namespace: Namespace, documentId: string): Promise<void>;
}

// ===========================================================================
// Reranker
// ===========================================================================

/**
 * Cross-encoder reranking.
 *
 * A retrieval embedding is computed BEFORE the model has seen your question — it
 * is a lossy compression optimized for the average case. A reranker scores the
 * query and document together, so it can tell that a chunk about "returns" is
 * really about exchange eligibility. Typically the second-largest quality gain
 * after contextual chunking (docs/04-retrieval.md §4.4).
 */
export interface Reranker {
  rerank(query: string, chunks: readonly ScoredChunk[], topN: number): Promise<readonly ScoredChunk[]>;
}

/**
 * A no-op reranker.
 *
 * Ships here rather than in tests because "skip reranking" is a legitimate
 * production configuration for latency-sensitive routes — and having it satisfy
 * the same interface means that choice is a wiring change, not a code branch.
 */
export const passthroughReranker: Reranker = {
  rerank: async (_query, chunks, topN) => chunks.slice(0, topN),
};

// ===========================================================================
// Product catalog
// ===========================================================================

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}

export interface ProductCatalog {
  /**
   * Hydrate live from Shopify. THE ONLY SOURCE OF PRICE AND STOCK.
   *
   * Batch these into one request — N round trips for N candidates is the
   * difference between a 120ms hop and a timeout.
   */
  getByIds(ids: readonly ProductId[]): Promise<readonly Product[]>;
  getByHandle(handle: ProductHandle): Promise<Product | null>;
  /** Ingestion only — walks the catalog for the nightly embedding sync. */
  listAll(cursor?: string): Promise<Page<Product>>;
}

/**
 * Warm cache for display metadata.
 *
 * Note the type it stores: `CachedProductMetadata`, which structurally cannot
 * hold a price. The cache is an optimization for titles and images, never a
 * fallback for facts.
 */
export interface ProductMetadataCache {
  get(id: ProductId): Promise<CachedProductMetadata | null>;
  putMany(items: readonly CachedProductMetadata[]): Promise<void>;
}

// ===========================================================================
// Conversation repository
// ===========================================================================

export interface ConversationRepository {
  loadSession(id: SessionId): Promise<Session | null>;
  createSession(session: Session): Promise<void>;

  /**
   * Persist the session, failing if `expectedVersion` no longer matches.
   *
   * Optimistic concurrency: two browser tabs posting simultaneously would
   * otherwise interleave turns into nonsense. Rare, but a genuinely confusing
   * bug when it happens (docs/05-chat-lifecycle.md §5.5).
   */
  saveSession(session: Session, expectedVersion: number): Promise<void>;

  loadRecentMessages(id: SessionId, limit: number): Promise<readonly Message[]>;

  /** Idempotent on `Message.id`, so a double-click cannot duplicate a turn. */
  appendMessages(id: SessionId, messages: readonly Message[], ttlEpochSeconds: number): Promise<void>;

  findSessionsByCustomer(customerId: CustomerId): Promise<readonly SessionId[]>;
}

// ===========================================================================
// Knowledge repository (ingestion side)
// ===========================================================================

export interface KnowledgeRepository {
  putChunks(chunks: readonly Chunk[]): Promise<void>;
  getChunks(ids: readonly ChunkId[]): Promise<readonly Chunk[]>;
}

// ===========================================================================
// Secrets
// ===========================================================================

/**
 * Fetch a secret by logical name.
 *
 * Adapters MUST cache in module scope. Fetching on every invocation adds ~30ms
 * and real API cost for a value that changes monthly at most — one of the most
 * common self-inflicted Lambda latency wounds (docs/02-aws-services.md §2.9).
 */
export interface SecretsProvider {
  get(name: string): Promise<string>;
}
