/**
 * The knowledge plane: chunks of company documents.
 *
 * Unlike products, this data is safe to embed — a return policy is true until
 * someone edits the document, and editing the document re-runs ingestion. The
 * embedding and the truth stay in sync (docs/01-architecture.md §1.2).
 */

import type { ChunkId, DocumentId } from "../shared/brand.js";

export type DocType = "policy" | "guide" | "faq";

export interface Chunk {
  readonly id: ChunkId;
  readonly documentId: DocumentId;
  readonly title: string;
  readonly section: string;
  readonly page: number | null;
  readonly docType: DocType;

  /**
   * The chunk as written. THIS is what a customer may be shown.
   */
  readonly text: string;

  /**
   * A short generated header situating the chunk in its document, e.g.
   * "[Return Policy — Section 3: Condition Requirements...]".
   *
   * WHY IT EXISTS: a chunk pulled out of a document loses its context. "Items
   * must be returned in original packaging" — returned under what policy, within
   * what window? The embedding has no idea and neither would the model.
   *
   * We embed `contextHeader + text` but store and display `text` alone. The
   * header is a retrieval aid, not customer-facing copy. This is Anthropic's
   * "contextual retrieval" technique and it is the best quality-per-dollar
   * change in the whole ingestion pipeline (docs/03-ingestion.md §3.4).
   */
  readonly contextHeader: string | null;

  readonly version: string;
  readonly embeddingModel: string;
}

/** A chunk plus its relevance to a specific query. */
export interface ScoredChunk {
  readonly chunk: Chunk;
  /** Cosine similarity from the vector store, 0..1. */
  readonly score: number;
  /** Cross-encoder score, when reranking ran. Null when it was skipped. */
  readonly rerankScore: number | null;
}

/** Exactly what gets embedded — one function, so it can never drift per caller. */
export function embeddingText(chunk: Pick<Chunk, "text" | "contextHeader">): string {
  return chunk.contextHeader ? `${chunk.contextHeader}\n\n${chunk.text}` : chunk.text;
}

/**
 * The score that should drive ranking decisions.
 *
 * Prefers the rerank score when present. Centralised because "which score do I
 * compare?" is exactly the kind of question that gets answered inconsistently
 * across a codebase, producing subtly different behaviour in different paths.
 */
export function effectiveScore(scored: ScoredChunk): number {
  return scored.rerankScore ?? scored.score;
}
