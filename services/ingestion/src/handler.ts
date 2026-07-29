/**
 * The ingestion Lambda.
 *
 * ============================================================================
 * WHY THIS IS A LAMBDA AND NOT A STEP FUNCTION
 * ============================================================================
 *
 * docs/03-ingestion.md specifies Step Functions with a `Map` state at
 * MaxConcurrency 5. That design is correct — for the numbers it was written
 * against. Then the pipeline ran against the real corpus:
 *
 *     2 documents  ->  7 chunks   ->  1 embedding call
 *     40 products  ->  40 texts   ->  1 embedding call
 *
 * The entire job is two Bedrock calls and finishes inside a few seconds. Step
 * Functions exists to solve fan-out across Bedrock TPM limits, retry
 * orchestration across many independent units, and documents too large for one
 * Lambda. None of those conditions hold at two orders of magnitude below the
 * threshold, and a state machine brings its own IAM, its own definition to keep
 * in sync, and its own failure modes to learn.
 *
 * THE THRESHOLD, written down so this is a decision and not a drift:
 *
 *   - a single run approaches the 15-minute Lambda ceiling, or
 *   - embedding needs concurrency to stay under Bedrock TPM (roughly: thousands
 *     of chunks per run), or
 *   - one document no longer fits in Lambda memory.
 *
 * Reach any of those and the Map state earns its place. Until then this handler
 * calls the same core functions the state machine would have called, so the
 * migration is a wiring change and not a rewrite.
 *
 * ============================================================================
 * WHAT TRIGGERS IT
 * ============================================================================
 *
 *   S3 ObjectCreated   -> reingest that one document
 *   S3 ObjectRemoved   -> purge that document's vectors
 *   EventBridge (cron) -> resync the product catalogue
 *   Manual invoke      -> whatever `mode` says
 */

import { createHash } from "node:crypto";
import {
  DocumentId,
  ingestDocument,
  ingestProducts,
  type DocType,
  type SourceDocument,
} from "@nailzify/core";
import type { IngestionDeps } from "./composition-root.js";

export type IngestionEvent =
  | { readonly mode: "products" }
  | { readonly mode: "documents" }
  | { readonly mode: "all" }
  | { readonly Records: readonly S3Record[] };

interface S3Record {
  readonly eventName: string;
  readonly s3: {
    readonly bucket: { readonly name: string };
    readonly object: { readonly key: string };
  };
}

export interface IngestionResult {
  readonly ok: boolean;
  readonly documents: readonly {
    readonly documentId: string;
    readonly action: "indexed" | "skipped" | "removed";
    readonly chunks: number;
  }[];
  readonly products: {
    readonly indexed: number;
    readonly accessories: number;
    readonly removed: number;
  } | null;
  readonly warnings: readonly string[];
}

/**
 * Extensions this pipeline will ingest.
 *
 * ⚠️ NOT PDF, deliberately. The PDFs in data/documents/pdf are GENERATED from the
 * markdown next to them — they exist so a customer can download a size guide, not
 * as a source of truth. Ingesting them would mean extracting text from a file we
 * produced from text we already have: a lossy round trip through a layout format,
 * for no gain, that turns a clean table into whatever the extractor makes of it.
 *
 * A PDF that ARRIVES as a PDF — a supplier document, a scanned form — is a real
 * case, and the extraction seam belongs here when one shows up.
 */
const INGESTIBLE = /\.(md|markdown|txt)$/i;

export async function handleIngestion(
  event: IngestionEvent,
  deps: IngestionDeps,
): Promise<IngestionResult> {
  if ("Records" in event) return handleS3Records(event.Records, deps);

  const documents =
    event.mode === "documents" || event.mode === "all" ? await syncAllDocuments(deps) : [];
  const products =
    event.mode === "products" || event.mode === "all" ? await syncProducts(deps) : null;

  return { ok: true, documents, products, warnings: deps.drainWarnings() };
}

// ---------------------------------------------------------------------------
// S3-triggered: one object changed
// ---------------------------------------------------------------------------

async function handleS3Records(
  records: readonly S3Record[],
  deps: IngestionDeps,
): Promise<IngestionResult> {
  const documents: IngestionResult["documents"][number][] = [];
  const warnings: string[] = [];

  for (const record of records) {
    // S3 percent-encodes keys in event notifications, and turns spaces into "+".
    // Reading the raw key means "size guide.md" is looked up as "size+guide.md"
    // and 404s — a failure that only appears for filenames with spaces.
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const id = documentIdFromKey(key);

    if (record.eventName.startsWith("ObjectRemoved")) {
      // Deleting the object does not remove the vectors. Without this the bot
      // keeps quoting a policy that no longer exists — worse than having no
      // policy, because it is confidently wrong.
      await deps.vectors.deleteByDocument("knowledge", id);
      await deps.state.putDocumentVersion(id, "");
      documents.push({ documentId: id, action: "removed", chunks: 0 });
      continue;
    }

    if (!INGESTIBLE.test(key)) {
      warnings.push(`Ignored ${key}: not an ingestible document type.`);
      continue;
    }

    const markdown = await deps.documents.read(record.s3.bucket.name, key);
    const report = await ingestOne(toSourceDocument(id, key, markdown), deps);
    documents.push(report);
  }

  return { ok: true, documents, products: null, warnings: [...warnings, ...deps.drainWarnings()] };
}

// ---------------------------------------------------------------------------
// Scheduled: reconcile everything
// ---------------------------------------------------------------------------

async function syncAllDocuments(deps: IngestionDeps): Promise<IngestionResult["documents"]> {
  const keys = (await deps.documents.list()).filter((k) => INGESTIBLE.test(k));
  const results: IngestionResult["documents"][number][] = [];

  for (const key of keys) {
    const markdown = await deps.documents.read(deps.documentBucket, key);
    results.push(await ingestOne(toSourceDocument(documentIdFromKey(key), key, markdown), deps));
  }

  // Vectors for documents whose S3 object is gone. The ObjectRemoved handler
  // covers the normal path; this catches events that were missed — a delete
  // during a deploy, a bulk removal via the console, a notification dropped.
  // Orphaned vectors mean the bot quotes a policy the store no longer has.
  const liveIds = new Set(keys.map(documentIdFromKey));
  for (const indexed of await deps.state.listIndexedDocuments()) {
    if (!liveIds.has(indexed)) {
      await deps.vectors.deleteByDocument("knowledge", indexed);
      await deps.state.putDocumentVersion(indexed, "");
      results.push({ documentId: indexed, action: "removed", chunks: 0 });
    }
  }

  return results;
}

async function syncProducts(deps: IngestionDeps): Promise<IngestionResult["products"]> {
  const previouslyIndexed = await deps.state.listIndexedProducts();

  const report = await ingestProducts(
    { catalog: deps.catalog, embedder: deps.embedder, vectors: deps.vectors },
    previouslyIndexed,
  );

  await deps.state.replaceIndexedProducts(report.indexedIds);

  return {
    indexed: report.productsIndexed,
    accessories: report.accessoriesIndexed,
    removed: report.removed.length,
  };
}

// ---------------------------------------------------------------------------

async function ingestOne(
  document: SourceDocument,
  deps: IngestionDeps,
): Promise<IngestionResult["documents"][number]> {
  const previous = await deps.state.getDocumentVersion(document.id);

  const report = await ingestDocument(document, previous || null, {
    embedder: deps.embedder,
    vectors: deps.vectors,
  });

  // Recorded only after the write succeeded. Recording it first would make a
  // failed run look complete to the next one, which would then skip the document
  // that never got indexed.
  if (!report.skipped) await deps.state.putDocumentVersion(document.id, document.version);

  return {
    documentId: document.id,
    action: report.skipped ? "skipped" : "indexed",
    chunks: report.chunksWritten,
  };
}

function toSourceDocument(id: string, key: string, markdown: string): SourceDocument {
  return {
    id: DocumentId(id),
    title: /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? id,
    docType: docTypeOf(key),
    markdown,
    // Content hash, not the S3 LastModified. A re-upload of an identical file
    // changes LastModified and would re-embed the whole document for nothing.
    version: createHash("sha256").update(markdown).digest("hex").slice(0, 16),
  };
}

/** `raw/policies/return-policy.md` -> `return-policy` */
function documentIdFromKey(key: string): string {
  return key.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
}

function docTypeOf(key: string): DocType {
  const name = key.toLowerCase();
  if (name.includes("policy") || name.includes("return") || name.includes("shipping")) {
    return "policy";
  }
  if (name.includes("faq")) return "faq";
  return "guide";
}
