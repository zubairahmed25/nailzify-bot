/**
 * Turning a source document into searchable knowledge.
 *
 * ============================================================================
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * ============================================================================
 *
 * Re-ingesting a document is not "add some vectors". It is REPLACING what is
 * already there, and the obvious implementation is wrong:
 *
 *     delete the old chunks -> chunk -> embed -> upsert          ❌
 *
 * If embedding fails — throttled, model access revoked, network — the document
 * is now gone from the index and the bot answers "I don't have information about
 * returns" to every customer until someone notices. The failure is silent,
 * because nothing threw where anyone was looking.
 *
 * So the order here is:
 *
 *     chunk -> embed everything -> delete the old -> upsert the new    ✅
 *
 * Every expensive, failure-prone step happens BEFORE anything is destroyed. A
 * failure at any point leaves the previous version of the document serving
 * traffic, which is the correct outcome: stale beats absent.
 *
 * The remaining window — between delete and upsert — is real but small
 * (milliseconds, one round trip). Closing it entirely needs versioned namespaces
 * and an atomic alias swap, which is the right answer at a scale this store is
 * nowhere near. It is written down in docs/03-ingestion.md rather than built.
 *
 * ============================================================================
 * WHY UNCHANGED DOCUMENTS ARE SKIPPED
 * ============================================================================
 *
 * Not primarily to save money, though it does. It is because the safest re-ingest
 * is the one that does not happen: skipping means no delete, so no window at all
 * for the 99% of runs where nothing changed.
 */

import { ChunkId, type DocumentId } from "../domain/shared/brand.js";
import type { Chunk, DocType } from "../domain/knowledge/chunk.js";
import { embeddingText } from "../domain/knowledge/chunk.js";
import {
  DEFAULT_CHUNKING_POLICY,
  chunkMarkdown,
  structuralContextHeader,
  type ChunkDraft,
  type ChunkingPolicy,
} from "../domain/knowledge/chunking.js";
import type { Embedder, KnowledgeRepository, VectorStore } from "../ports/index.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SourceDocument {
  readonly id: DocumentId;
  readonly title: string;
  readonly docType: DocType;
  /** The document body. PDFs are converted upstream; this layer sees markdown. */
  readonly markdown: string;
  /**
   * A content fingerprint — a hash, a git sha, an ETag, a last-modified date.
   *
   * Compared against what was ingested last time to decide whether to skip. It
   * must change whenever the text changes and must NOT change otherwise, or the
   * pipeline either misses updates or re-ingests constantly.
   */
  readonly version: string;
}

/**
 * Optional LLM-generated context headers.
 *
 * Contextual retrieval is the single largest quality gain in this pipeline, and
 * a structural header ("[Return Policy — Eligibility]") already captures most of
 * it for free. An LLM can do better by writing a sentence that situates the
 * chunk in the surrounding argument.
 *
 * It is OPTIONAL and failure here is non-fatal: a document ingested with
 * structural headers is worse than one with generated headers, but both work.
 * Refusing to ingest at all because an enrichment call timed out would be
 * choosing the worst outcome of the three.
 */
export interface ContextEnricher {
  enrich(input: {
    readonly documentTitle: string;
    readonly wholeDocument: string;
    readonly chunk: string;
  }): Promise<string>;
}

export interface IngestKnowledgeDeps {
  readonly embedder: Embedder;
  readonly vectors: VectorStore;
  /**
   * OPTIONAL, and deliberately so.
   *
   * Retrieval reads chunk text out of VECTOR METADATA — see `searchKnowledge` in
   * the store adapters. Nothing in the read path touches this repository, so
   * requiring it would mean building and operating a DynamoDB table that is
   * written to and never read from. That is not durability, it is ceremony.
   *
   * WHEN IT STOPS BEING OPTIONAL: when a chunk no longer fits in vector metadata.
   * Pinecone allows 40KB per record; our hard ceiling is 1000 tokens (~4KB), so
   * there is a 10x margin today. Raise maxTokens past ~8000, or move to a store
   * with tighter metadata limits, and the text has to live somewhere else — at
   * which point this port is already here and the ingestion code already calls it.
   *
   * The port existing without an adapter is the point: the seam is designed, the
   * implementation is deferred until something needs it.
   */
  readonly knowledge?: KnowledgeRepository;
  readonly chunkingPolicy?: ChunkingPolicy;
  readonly enricher?: ContextEnricher;
  /**
   * Embeddings per API call. Cohere accepts up to 96; the default leaves room
   * so a batch of long chunks cannot exceed the per-request token ceiling.
   */
  readonly batchSize?: number;
  readonly onProgress?: (event: IngestProgress) => void;
}

export type IngestProgress =
  | { readonly kind: "skipped"; readonly documentId: DocumentId; readonly version: string }
  | { readonly kind: "chunked"; readonly documentId: DocumentId; readonly chunks: number }
  | { readonly kind: "enrich-failed"; readonly documentId: DocumentId; readonly reason: string }
  | { readonly kind: "embedded"; readonly documentId: DocumentId; readonly done: number; readonly total: number }
  | { readonly kind: "written"; readonly documentId: DocumentId; readonly chunks: number };

export interface IngestReport {
  readonly documentId: DocumentId;
  readonly skipped: boolean;
  readonly chunksWritten: number;
  readonly embeddingCalls: number;
  /** True when enrichment was requested but fell back to structural headers. */
  readonly enrichmentDegraded: boolean;
}

const DEFAULT_BATCH_SIZE = 64;

// ---------------------------------------------------------------------------

/**
 * Ingest one document, replacing any previous version of it.
 *
 * `previousVersion` is passed in rather than looked up, so this function stays
 * pure with respect to storage — the caller owns where that bookkeeping lives.
 * Pass `null` to force a full re-ingest.
 */
export async function ingestDocument(
  document: SourceDocument,
  previousVersion: string | null,
  deps: IngestKnowledgeDeps,
): Promise<IngestReport> {
  const report = (over: Partial<IngestReport>): IngestReport => ({
    documentId: document.id,
    skipped: false,
    chunksWritten: 0,
    embeddingCalls: 0,
    enrichmentDegraded: false,
    ...over,
  });

  if (previousVersion !== null && previousVersion === document.version) {
    deps.onProgress?.({ kind: "skipped", documentId: document.id, version: document.version });
    return report({ skipped: true });
  }

  // ---- 1. Chunk -----------------------------------------------------------
  const drafts = chunkMarkdown(document.markdown, deps.chunkingPolicy ?? DEFAULT_CHUNKING_POLICY);

  if (drafts.length === 0) {
    // An empty document is almost always a broken extraction — a PDF that
    // produced no text, a fetch that returned an error page. Deleting the
    // existing chunks on that basis would destroy good data because an upstream
    // step failed quietly. Refuse instead.
    throw new EmptyDocumentError(document.id, document.title);
  }

  deps.onProgress?.({ kind: "chunked", documentId: document.id, chunks: drafts.length });

  // ---- 2. Context headers -------------------------------------------------
  const { headers, degraded } = await buildContextHeaders(document, drafts, deps);

  // ---- 3. Embed -----------------------------------------------------------
  //
  // Everything above this line is cheap and local. Everything below can fail on
  // someone else's infrastructure — which is exactly why the destructive step
  // comes after it, not before.
  const chunks: Chunk[] = drafts.map((draft, i) => ({
    id: chunkIdFor(document.id, draft),
    documentId: document.id,
    title: document.title,
    section: draft.section,
    // Page numbers survive only if the extractor supplied them. Markdown has no
    // pages, so this is null until a PDF adapter fills it in.
    page: null,
    docType: document.docType,
    text: draft.text,
    contextHeader: headers[i] ?? null,
    version: document.version,
    embeddingModel: deps.embedder.modelId,
  }));

  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const vectors: (readonly number[])[] = [];
  let embeddingCalls = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    // `embeddingText` prepends the context header. We embed header + text but
    // STORE text alone — the header is a retrieval aid, never customer-facing.
    const embedded = await deps.embedder.embedBatch(batch.map(embeddingText), "document");
    embeddingCalls += 1;

    if (embedded.length !== batch.length) {
      // A silent length mismatch would pair every subsequent chunk with the
      // wrong vector — a corruption that produces plausible-looking but
      // systematically wrong retrieval, and no error anywhere.
      throw new EmbeddingMismatchError(document.id, batch.length, embedded.length);
    }

    vectors.push(...embedded);
    deps.onProgress?.({
      kind: "embedded",
      documentId: document.id,
      done: Math.min(i + batchSize, chunks.length),
      total: chunks.length,
    });
  }

  assertDimensions(chunks, vectors, deps.embedder);

  // ---- 4. Replace ---------------------------------------------------------
  //
  // Only now, with every vector in hand, do we touch what is already live.
  await deps.vectors.deleteByDocument("knowledge", document.id);
  await deps.vectors.upsert(
    "knowledge",
    chunks.map((chunk, i) => ({
      id: chunk.id,
      values: vectors[i]!,
      metadata: knowledgeMetadata(chunk),
    })),
  );

  // Only when a repository is wired. Vector metadata is the system of record for
  // chunk text today — see the note on the `knowledge` dependency above.
  await deps.knowledge?.putChunks(chunks);

  deps.onProgress?.({ kind: "written", documentId: document.id, chunks: chunks.length });

  return report({ chunksWritten: chunks.length, embeddingCalls, enrichmentDegraded: degraded });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable, content-independent chunk id.
 *
 * Derived from position, not from text, so that a typo fix in paragraph 3 does
 * not orphan the vector for paragraph 3 and leave both the old and the new one
 * in the index. Position-derived ids mean re-ingest overwrites in place; the
 * delete-by-document above then only has to clean up chunks that no longer
 * exist because the document got shorter.
 */
function chunkIdFor(documentId: DocumentId, draft: ChunkDraft): ChunkId {
  return ChunkId(`${documentId}#${draft.sectionIndex}.${draft.chunkIndex}`);
}

async function buildContextHeaders(
  document: SourceDocument,
  drafts: readonly ChunkDraft[],
  deps: IngestKnowledgeDeps,
): Promise<{ headers: string[]; degraded: boolean }> {
  const structural = drafts.map((d) => structuralContextHeader(document.title, d));
  if (!deps.enricher) return { headers: structural, degraded: false };

  try {
    const enriched = await Promise.all(
      drafts.map((draft) =>
        deps.enricher!.enrich({
          documentTitle: document.title,
          wholeDocument: document.markdown,
          chunk: draft.text,
        }),
      ),
    );
    // A blank result is a failed generation, not a valid header.
    return {
      headers: enriched.map((h, i) => h.trim() || structural[i]!),
      degraded: false,
    };
  } catch (error) {
    // Degrade, do not fail. A document with structural headers is worse than one
    // with generated headers; a document that is missing entirely is worse than
    // both.
    deps.onProgress?.({
      kind: "enrich-failed",
      documentId: document.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { headers: structural, degraded: true };
  }
}

/**
 * Metadata stored alongside a knowledge vector.
 *
 * Mirrors the reader in the vector store adapters. Same drift hazard as product
 * metadata, same reasoning — see productVectorMetadata in domain/catalog.
 */
function knowledgeMetadata(chunk: Chunk): Record<string, unknown> {
  return {
    documentId: chunk.documentId,
    title: chunk.title,
    section: chunk.section,
    docType: chunk.docType,
    text: chunk.text,
    contextHeader: chunk.contextHeader ?? "",
    version: chunk.version,
    embeddingModel: chunk.embeddingModel,
    ...(chunk.page !== null ? { page: chunk.page } : {}),
  };
}

function assertDimensions(
  chunks: readonly Chunk[],
  vectors: readonly (readonly number[])[],
  embedder: Embedder,
): void {
  if (vectors.length !== chunks.length) {
    throw new EmbeddingMismatchError(chunks[0]!.documentId, chunks.length, vectors.length);
  }
  // Cohere embed-v4 defaults to 1536 dimensions and we pin 1024. If that pin
  // ever silently stops applying, the upsert fails deep inside the vector store
  // with a message about index dimensions. Checking here names the real cause.
  const wrong = vectors.findIndex((v) => v.length !== embedder.dimensions);
  if (wrong !== -1) {
    throw new Error(
      `Embedder ${embedder.modelId} declares ${embedder.dimensions} dimensions but returned ` +
        `${vectors[wrong]!.length} for chunk ${chunks[wrong]!.id}. The index will reject this.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmptyDocumentError extends Error {
  constructor(
    readonly documentId: DocumentId,
    title: string,
  ) {
    super(
      `Document "${title}" (${documentId}) produced no chunks. Refusing to ingest — ` +
        `this is almost always a failed extraction, and continuing would delete the ` +
        `existing chunks for a document that is still perfectly good.`,
    );
    this.name = "EmptyDocumentError";
  }
}

export class EmbeddingMismatchError extends Error {
  constructor(documentId: DocumentId, expected: number, received: number) {
    super(
      `Embedder returned ${received} vectors for ${expected} chunks of ${documentId}. ` +
        `Refusing to continue: pairing chunks with the wrong vectors corrupts retrieval ` +
        `in a way that produces plausible answers and no errors.`,
    );
    this.name = "EmbeddingMismatchError";
  }
}
