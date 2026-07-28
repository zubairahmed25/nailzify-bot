/**
 * Pinecone adapter — implements the `VectorStore` port.
 *
 * ============================================================================
 * WHY THIS FILE IS THE ONLY PLACE PINECONE IS MENTIONED
 * ============================================================================
 *
 * docs/02-aws-services.md §2.5 chose Pinecone on cost grounds while flagging
 * OpenSearch Serverless, Aurora pgvector and S3 Vectors as plausible future
 * homes. That promise is only real if the vendor is confined to one file.
 *
 * So the port exposes three domain-shaped methods, not Pinecone's API. Note in
 * particular that `searchProducts` returns `ProductCandidate[]` — a type that
 * structurally cannot carry a price. Even if someone stuffed a price into vector
 * metadata, it could not escape this adapter into the domain.
 *
 * Migration cost = reimplement this file + re-index. Not a rewrite.
 */

import { Pinecone, type RecordMetadata } from "@pinecone-database/pinecone";
import type {
  KnowledgeFilter,
  Namespace,
  ProductFilter,
  VectorRecord,
  VectorStore,
} from "@nailzify/core";
import {
  productAttributesFromMetadata,
  ChunkId,
  DocumentId,
  ProductId,
  VectorStoreUnavailable,
  type Chunk,
  type DocType,
  type PriceBand,
  type ProductCandidate,
  type ScoredChunk,
} from "@nailzify/core";

export interface PineconeConfig {
  readonly apiKey: string;
  readonly indexName: string;
}

export function createPineconeVectorStore(config: PineconeConfig): VectorStore {
  const index = new Pinecone({ apiKey: config.apiKey }).index(config.indexName);
  const ns = (namespace: Namespace) => index.namespace(namespace);

  return {
    async upsert(namespace, records) {
      if (records.length === 0) return;
      try {
        // Pinecone caps upsert payload size. Batching at 100 keeps us well under
        // it for 1024-dim vectors with metadata, and bounds the blast radius of
        // a single failed request during a bulk re-index.
        for (let i = 0; i < records.length; i += 100) {
          await ns(namespace).upsert(records.slice(i, i + 100).map(toPineconeRecord));
        }
      } catch (cause) {
        throw new VectorStoreUnavailable("Pinecone upsert failed", { cause });
      }
    },

    async searchKnowledge(vector, topK, filter) {
      try {
        const result = await ns("knowledge").query({
          vector: [...vector],
          topK,
          includeMetadata: true,
          ...(buildKnowledgeFilter(filter) ?? {}),
        });
        return (result.matches ?? []).map(toScoredChunk);
      } catch (cause) {
        throw new VectorStoreUnavailable("Pinecone knowledge query failed", { cause });
      }
    },

    async searchProducts(vector, topK, filter) {
      try {
        const result = await ns("products").query({
          vector: [...vector],
          topK,
          includeMetadata: true,
          ...(buildProductFilter(filter) ?? {}),
        });
        return (result.matches ?? []).map(toProductCandidate);
      } catch (cause) {
        throw new VectorStoreUnavailable("Pinecone product query failed", { cause });
      }
    },

    async deleteByDocument(namespace, documentId) {
      try {
        // Surgical invalidation: updating one policy re-ingests one policy
        // rather than rebuilding the whole index (docs/03-ingestion.md §3.5).
        await ns(namespace).deleteMany({ documentId: { $eq: documentId } });
      } catch (cause) {
        throw new VectorStoreUnavailable("Pinecone delete failed", { cause });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping: domain -> Pinecone
// ---------------------------------------------------------------------------

function toPineconeRecord(record: VectorRecord) {
  return {
    id: record.id,
    values: [...record.values],
    metadata: record.metadata as RecordMetadata,
  };
}

/**
 * Metadata filters run BEFORE vector search, shrinking the candidate space.
 *
 * This is a precision lever, not just an optimization: searching 40 almond-shaped
 * products beats searching 800 of every shape and hoping similarity sorts it out.
 */
function buildKnowledgeFilter(filter?: KnowledgeFilter) {
  if (!filter) return undefined;
  const clauses: Record<string, unknown> = {};
  if (filter.docType) clauses["docType"] = { $eq: filter.docType };
  if (filter.documentId) clauses["documentId"] = { $eq: filter.documentId };
  return Object.keys(clauses).length > 0 ? { filter: clauses } : undefined;
}

function buildProductFilter(filter?: ProductFilter) {
  if (!filter) return undefined;
  const clauses: Record<string, unknown> = {};
  if (filter.shape) clauses["shape"] = { $eq: filter.shape };
  if (filter.length) clauses["length"] = { $eq: filter.length };
  if (filter.occasion) clauses["occasions"] = { $in: [filter.occasion] };
  if (filter.priceBands?.length) clauses["priceBand"] = { $in: [...filter.priceBands] };
  return Object.keys(clauses).length > 0 ? { filter: clauses } : undefined;
}

// ---------------------------------------------------------------------------
// Mapping: Pinecone -> domain
// ---------------------------------------------------------------------------

interface Match {
  readonly id: string;
  readonly score?: number | undefined;
  readonly metadata?: RecordMetadata | undefined;
}

const str = (m: RecordMetadata | undefined, key: string, fallback = ""): string => {
  const v = m?.[key];
  return typeof v === "string" ? v : fallback;
};

const strArray = (m: RecordMetadata | undefined, key: string): string[] => {
  const v = m?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

function toScoredChunk(match: Match): ScoredChunk {
  const m = match.metadata;
  const page = m?.["page"];

  const chunk: Chunk = {
    id: ChunkId(match.id),
    documentId: DocumentId(str(m, "documentId", "unknown")),
    title: str(m, "title"),
    section: str(m, "section"),
    page: typeof page === "number" ? page : null,
    docType: (str(m, "docType", "policy") as DocType) ?? "policy",
    // The ORIGINAL text, not the contextualized version we embedded. The context
    // header is a retrieval aid and must never reach a customer.
    text: str(m, "text"),
    contextHeader: str(m, "contextHeader") || null,
    version: str(m, "version"),
    embeddingModel: str(m, "embeddingModel"),
  };

  return {
    chunk,
    score: match.score ?? 0,
    // Null until a reranker runs. `effectiveScore()` in core decides which to
    // use, so ranking logic never has to ask "which score do I compare?".
    rerankScore: null,
  };
}

/**
 * Build a candidate — deliberately NOT a Product.
 *
 * Everything here is stable descriptive data written at ingest time. If a price
 * were somehow present in metadata, this function would drop it, because
 * `ProductCandidate` has nowhere to put it. The type is the enforcement.
 */
function toProductCandidate(match: Match): ProductCandidate {
  const m = match.metadata;

  // Key names come from core so the writer and this reader cannot drift apart.
  const attributes = productAttributesFromMetadata({
    str: (k) => str(m, k),
    strArray: (k) => [...strArray(m, k)],
  });

  return {
    productId: ProductId(str(m, "productId", match.id)),
    score: match.score ?? 0,
    priceBand: (str(m, "priceBand", "15-25") as PriceBand) ?? "15-25",
    attributes,
  };
}
