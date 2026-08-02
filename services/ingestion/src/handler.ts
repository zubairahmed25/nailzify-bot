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
  classifyDocument,
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
  /** EventBridge — what the deployed bucket actually sends. */
  | EventBridgeS3Event
  /** Bucket notification — kept because it is trivial and easy to get wrong. */
  | { readonly Records: readonly S3Record[] };

interface EventBridgeS3Event {
  readonly source: "aws.s3";
  readonly "detail-type": string;
  readonly detail: {
    readonly bucket: { readonly name: string };
    readonly object: { readonly key: string };
  };
}

interface S3Record {
  readonly eventName: string;
  readonly s3: {
    readonly bucket: { readonly name: string };
    readonly object: { readonly key: string };
  };
}

/** One shape for both delivery mechanisms, so the logic below sees only this. */
interface ObjectChange {
  readonly removed: boolean;
  readonly bucket: string;
  readonly key: string;
}

/**
 * ⚠️ THE TWO EVENT SOURCES ENCODE KEYS DIFFERENTLY.
 *
 * A bucket NOTIFICATION percent-encodes the key and turns spaces into "+", so
 * "size guide.md" arrives as "size+guide.md" and a raw lookup 404s.
 * EventBridge sends the key VERBATIM. Decoding an EventBridge key would corrupt
 * any filename containing a legitimate "+" or "%".
 *
 * Both bugs only surface for filenames a non-engineer would produce through the
 * S3 console, which is exactly who uploads these documents.
 */
function toObjectChanges(event: ObjectEvent): readonly ObjectChange[] {
  if ("Records" in event) {
    return event.Records.map((record) => ({
      removed: record.eventName.startsWith("ObjectRemoved"),
      bucket: record.s3.bucket.name,
      key: decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")),
    }));
  }

  return [
    {
      removed: event["detail-type"] === "Object Deleted",
      bucket: event.detail.bucket.name,
      key: event.detail.object.key,
    },
  ];
}

type ObjectEvent = EventBridgeS3Event | { readonly Records: readonly S3Record[] };

/** Type predicate, not a boolean — narrowing is what makes the union usable. */
function isObjectEvent(event: IngestionEvent): event is ObjectEvent {
  return "Records" in event || ("source" in event && event.source === "aws.s3");
}

export interface IngestionResult {
  readonly ok: boolean;
  readonly documents: readonly {
    readonly documentId: string;
    readonly action: "indexed" | "skipped" | "removed" | "failed";
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
 * ⚠️ PDF WAS DELIBERATELY EXCLUDED HERE, AND THAT REASONING NO LONGER APPLIES TO
 * EVERY PDF. The PDFs in data/documents/pdf are GENERATED from the markdown next
 * to them — customer downloads, not a source of truth — and re-ingesting a file
 * we produced from text we already have would be a lossy round trip for nothing.
 * That reasoning is still correct for THOSE specific files, which live outside
 * `raw/` and are never uploaded here.
 *
 * It does not apply to a PDF that ARRIVES as a PDF — a merchant uploading a
 * policy document through the admin page, which has no markdown original to
 * prefer. See `isPdf` / `ingestPdf` below for that path: extract -> classify ->
 * the same chunk/embed pipeline every other document already goes through.
 */
const INGESTIBLE = /\.(md|markdown|txt|pdf)$/i;
const isPdf = (key: string): boolean => /\.pdf$/i.test(key);

export async function handleIngestion(
  event: IngestionEvent,
  deps: IngestionDeps,
): Promise<IngestionResult> {
  if (isObjectEvent(event)) return handleObjectChanges(toObjectChanges(event), deps);

  const documents =
    event.mode === "documents" || event.mode === "all" ? await syncAllDocuments(deps) : [];
  const products =
    event.mode === "products" || event.mode === "all" ? await syncProducts(deps) : null;

  return { ok: true, documents, products, warnings: deps.drainWarnings() };
}

// ---------------------------------------------------------------------------
// S3-triggered: one object changed
// ---------------------------------------------------------------------------

async function handleObjectChanges(
  changes: readonly ObjectChange[],
  deps: IngestionDeps,
): Promise<IngestionResult> {
  const documents: IngestionResult["documents"][number][] = [];
  const warnings: string[] = [];

  for (const change of changes) {
    const key = change.key;
    const id = documentIdFromKey(key);

    if (change.removed) {
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

    if (isPdf(key)) {
      documents.push(await ingestPdf(id, change.bucket, key, deps));
      continue;
    }

    const markdown = await deps.documents.read(change.bucket, key);
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
    if (isPdf(key)) {
      results.push(await ingestPdf(documentIdFromKey(key), deps.documentBucket, key, deps));
      continue;
    }
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

/**
 * Ingest a merchant-uploaded PDF: extract its text, classify it, then hand the
 * result to the SAME chunk/embed pipeline every other document already goes
 * through. `ingestOne` below is untouched by any of this — a PDF just becomes
 * another way to produce a `SourceDocument`.
 *
 * ⚠️ NEVER THROWS. Every other path in this file lets an error propagate,
 * because a bad markdown file is a developer mistake caught in code review, not
 * something happening live. A PDF upload is different: it is USER input,
 * arriving from a merchant who is looking at an admin page waiting for a
 * result. One bad PDF must not take down a whole scheduled sync — the batch
 * loops in `handleObjectChanges` and `syncAllDocuments` both call this in a
 * plain `for` loop with no surrounding try/catch, so the catch has to live
 * here or one failure silently stops every document after it in the batch.
 */
async function ingestPdf(
  id: string,
  bucket: string,
  key: string,
  deps: IngestionDeps,
): Promise<IngestionResult["documents"][number]> {
  try {
    const bytes = await deps.documents.readBytes(bucket, key);
    // Hashed from the ORIGINAL PDF BYTES — not the extracted text, not the
    // classified markdown. Both of those can change for reasons that have
    // nothing to do with the document itself changing: a library upgrade
    // reflowing whitespace, a prompt tweak that detects one more heading.
    // Hashing either would trigger a needless re-embed with no real change
    // behind it. The bytes are the only thing that is genuinely this document.
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

    // ⚠️ CHECKED BEFORE EXTRACTION, NOT AFTER. Markdown documents get this
    // skip for free — computing their version costs nothing extra because the
    // text is already in hand. A PDF's cheap-to-read bytes are ALSO already in
    // hand at this point, so checking now means an unchanged PDF costs one S3
    // read and nothing else: no extraction, and critically no Bedrock
    // classification call. Deferring this check to ingestOne (as the markdown
    // path effectively does) would re-pay a Bedrock call on every scheduled
    // resync for every PDF nobody touched — a real, recurring cost a markdown
    // file never has to pay.
    if ((await deps.state.getDocumentVersion(id)) === version) {
      // Still needs telling to the UPLOAD record. This path skips
      // classification entirely, so there is no fresh title/docType to
      // report — but recordUploadStarted no longer clobbers the existing
      // ones (packages/adapters/src/dynamodb/ingestion-state.ts), so there is
      // nothing to overwrite, only a status to flip back. Without this call a
      // re-upload of unchanged content — a merchant re-selecting the same
      // file, or a retry — left the admin page showing "Processing…" forever
      // for a document that was correctly indexed the whole time.
      await deps.state.recordUploadUnchanged(id);
      return { documentId: id, action: "skipped", chunks: 0 };
    }

    const rawText = await deps.pdfExtractor.extractText(bytes);
    const classification = await classifyDocument(rawText, { llm: deps.llm });

    const document: SourceDocument = {
      id: DocumentId(id),
      title: classification.title,
      docType: classification.docType,
      markdown: classification.markdown,
      version,
    };

    const report = await ingestOne(document, deps);

    // Only after ingestOne's own version-tracking write has succeeded — a
    // merchant seeing "Ready" on the admin page should mean the document is
    // genuinely searchable, not merely that classification finished.
    await deps.state.recordUploadReady({
      documentId: id,
      title: classification.title,
      docType: classification.docType,
    });

    // classification.unmatchedHeadings is deliberately not surfaced further
    // than this yet — it degrades to slightly coarser chunking, not a failure,
    // and there is no warnings channel reaching this function today. Worth
    // wiring up if a pattern of unmatched headings ever shows up in practice.

    return report;
  } catch (cause) {
    // Not distinguishing "the PDF was bad" from "Pinecone was down" here. Both
    // reach the merchant as this message verbatim — a known simplification, not
    // an oversight: an authenticated merchant looking at their own admin page is
    // not the audience the causeMessage-folding elsewhere in this codebase was
    // built to protect against, and "something failed, try again or contact
    // support" is still actionable even when the specific cause is not.
    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    await deps.state.recordUploadFailed({ documentId: id, errorMessage });
    return { documentId: id, action: "failed", chunks: 0 };
  }
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
