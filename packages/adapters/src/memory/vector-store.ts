/**
 * In-memory vector store — implements the same `VectorStore` port as Pinecone.
 *
 * ============================================================================
 * THIS FILE IS THE ARGUMENT FOR PORTS
 * ============================================================================
 *
 * ~120 lines and no network, no API key, no account. With it you can:
 *
 *   - run the full ingest -> search pipeline in a unit test, in milliseconds
 *   - develop offline
 *   - run retrieval evals in CI without provisioning a dev index
 *   - prove the Pinecone adapter's behaviour by diffing against this one
 *
 * None of that is possible if the application calls the Pinecone SDK directly.
 * The port is not architectural ceremony — it is what makes the system testable.
 *
 * Brute-force cosine over every vector: O(n) per query. That is fine for
 * thousands of vectors in a test and catastrophic for millions in production,
 * which is exactly why Pinecone exists. Same interface, different scaling
 * story — and the caller cannot tell them apart.
 */

import type {
  KnowledgeFilter,
  Namespace,
  ProductCandidate,
  ProductFilter,
  ScoredChunk,
  VectorRecord,
  VectorStore,
} from "@nailzify/core";
import {
  ChunkId,
  DocumentId,
  ProductId,
  type Chunk,
  type DocType,
  type NailLength,
  type NailShape,
  type Occasion,
  type PriceBand,
  type ProductAttributes,
} from "@nailzify/core";

type Store = Map<Namespace, Map<string, VectorRecord>>;

export interface InMemoryVectorStore extends VectorStore {
  /** Test helper: how many vectors live in a namespace. */
  size(namespace: Namespace): number;
  clear(): void;
}

export function createInMemoryVectorStore(): InMemoryVectorStore {
  const store: Store = new Map([
    ["knowledge", new Map()],
    ["products", new Map()],
  ]);

  const bucket = (ns: Namespace) => store.get(ns)!;

  function search(ns: Namespace, vector: readonly number[], topK: number, predicate: (r: VectorRecord) => boolean) {
    return [...bucket(ns).values()]
      .filter(predicate)
      .map((record) => ({ record, score: cosineSimilarity(vector, record.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  return {
    async upsert(namespace, records) {
      // Same idempotency contract as Pinecone: deterministic ids mean a repeated
      // ingest overwrites rather than duplicating (docs/03-ingestion.md §3.7).
      for (const record of records) bucket(namespace).set(record.id, record);
    },

    async searchKnowledge(vector, topK, filter) {
      return search("knowledge", vector, topK, (r) => matchesKnowledge(r, filter)).map(
        ({ record, score }) => toScoredChunk(record, score),
      );
    },

    async searchProducts(vector, topK, filter) {
      return search("products", vector, topK, (r) => matchesProduct(r, filter)).map(
        ({ record, score }) => toProductCandidate(record, score),
      );
    },

    async deleteByDocument(namespace, documentId) {
      const b = bucket(namespace);
      for (const [id, record] of b) {
        if (record.metadata["documentId"] === documentId) b.delete(id);
      }
    },

    size: (namespace) => bucket(namespace).size,
    clear: () => {
      for (const b of store.values()) b.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity — the angle between two vectors, ignoring magnitude.
 *
 * Magnitude in an embedding roughly tracks text length; direction carries
 * meaning. Ignoring magnitude is precisely why a two-word query can match a
 * 500-word passage: what matters is that they point the same way.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new TypeError(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

// ---------------------------------------------------------------------------
// Filtering — mirrors the Pinecone adapter's semantics
// ---------------------------------------------------------------------------

function matchesKnowledge(record: VectorRecord, filter?: KnowledgeFilter): boolean {
  if (!filter) return true;
  const m = record.metadata;
  if (filter.docType && m["docType"] !== filter.docType) return false;
  if (filter.documentId && m["documentId"] !== filter.documentId) return false;
  return true;
}

function matchesProduct(record: VectorRecord, filter?: ProductFilter): boolean {
  if (!filter) return true;
  const m = record.metadata;
  if (filter.shape && m["shape"] !== filter.shape) return false;
  if (filter.length && m["length"] !== filter.length) return false;
  if (filter.occasion) {
    const occasions = m["occasions"];
    if (!Array.isArray(occasions) || !occasions.includes(filter.occasion)) return false;
  }
  if (filter.priceBands?.length) {
    const band = m["priceBand"];
    if (typeof band !== "string" || !filter.priceBands.includes(band as PriceBand)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const str = (m: Record<string, unknown>, key: string, fallback = ""): string =>
  typeof m[key] === "string" ? (m[key] as string) : fallback;

const strArray = (m: Record<string, unknown>, key: string): string[] =>
  Array.isArray(m[key]) ? (m[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

function toScoredChunk(record: VectorRecord, score: number): ScoredChunk {
  const m = record.metadata;
  const page = m["page"];

  const chunk: Chunk = {
    id: ChunkId(record.id),
    documentId: DocumentId(str(m, "documentId", "unknown")),
    title: str(m, "title"),
    section: str(m, "section"),
    page: typeof page === "number" ? page : null,
    docType: str(m, "docType", "policy") as DocType,
    text: str(m, "text"),
    contextHeader: str(m, "contextHeader") || null,
    version: str(m, "version"),
    embeddingModel: str(m, "embeddingModel"),
  };

  return { chunk, score, rerankScore: null };
}

function toProductCandidate(record: VectorRecord, score: number): ProductCandidate {
  const m = record.metadata;

  const attributes: ProductAttributes = {
    shape: str(m, "shape", "almond") as NailShape,
    length: str(m, "length", "short") as NailLength,
    finish: str(m, "finish", "glossy") as ProductAttributes["finish"],
    occasions: strArray(m, "occasions") as Occasion[],
    suitableFor: strArray(m, "suitableFor") as ProductAttributes["suitableFor"],
    colourNotes: strArray(m, "colourNotes"),
  };

  return {
    productId: ProductId(str(m, "productId", record.id)),
    score,
    priceBand: str(m, "priceBand", "15-25") as PriceBand,
    attributes,
  };
}
