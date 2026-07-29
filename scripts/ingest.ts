/**
 * Run the ingestion pipeline against real data.
 *
 *     npx vite-node scripts/ingest.ts              # both planes
 *     npx vite-node scripts/ingest.ts knowledge    # documents only
 *     npx vite-node scripts/ingest.ts products     # catalogue only
 *     npx vite-node scripts/ingest.ts --dry-run    # chunk and report, embed nothing
 *
 * WHY A SCRIPT BEFORE A LAMBDA. Every assumption in this codebase that survived
 * contact with reality was one that got measured — tag parsing, embedding
 * dimensions, relevance floors, the size chart, the price tie-break. A Lambda
 * hides its output behind CloudWatch and a deployment. This prints what happened
 * to a terminal, which is where a wrong assumption is cheapest to notice.
 *
 * The Lambda handler wraps this same core function. Nothing here is throwaway.
 *
 * Required:
 *   AWS_REGION, AWS credentials             (Bedrock: embeddings)
 *   PINECONE_API_KEY, PINECONE_INDEX        (vector store)
 *   SHOPIFY_SHOP_DOMAIN, SHOPIFY_STOREFRONT_TOKEN   (products only)
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  DocumentId,
  ProductId,
  ingestDocument,
  ingestProducts,
  type DocType,
  type SourceDocument,
} from "@nailzify/core";
import {
  EMBEDDING_MODEL,
  createBedrockEmbedder,
  createPineconeVectorStore,
  createShopifyProductCatalog,
  createStorefrontClient,
} from "@nailzify/adapters";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const only = args.has("knowledge") ? "knowledge" : args.has("products") ? "products" : "both";

const DOCS_DIR = "data/documents";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(28)} ${String(value)}`);
const header = (n: number, title: string) => console.log(`\n${n}. ${title}`);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing ${name}.\n`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * The document version is a hash of the CONTENT, not a timestamp.
 *
 * A timestamp changes when a file is touched, copied or checked out, which would
 * re-embed the entire corpus on every CI run. A content hash changes when, and
 * only when, the text changes — which is the condition the skip logic actually
 * cares about.
 */
const contentVersion = (markdown: string) =>
  createHash("sha256").update(markdown).digest("hex").slice(0, 16);

/** Inferred from the filename. Only three types exist; see DocType. */
function docTypeOf(name: string): DocType {
  if (name.includes("policy") || name.includes("return") || name.includes("shipping")) return "policy";
  if (name.includes("faq")) return "faq";
  return "guide";
}

/** Title from the first H1, falling back to the filename. */
function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;
}

async function loadDocuments(): Promise<SourceDocument[]> {
  const names = (await readdir(DOCS_DIR)).filter((n) => extname(n) === ".md").sort();

  return Promise.all(
    names.map(async (name) => {
      const markdown = await readFile(join(DOCS_DIR, name), "utf8");
      const slug = basename(name, ".md");
      return {
        id: DocumentId(slug),
        title: titleOf(markdown, slug),
        docType: docTypeOf(slug),
        markdown,
        version: contentVersion(markdown),
      } satisfies SourceDocument;
    }),
  );
}

// ---------------------------------------------------------------------------
// Ingestion state
//
// What was ingested last time, so unchanged documents can be skipped and deleted
// products can be detected. A JSON file locally; DynamoDB in the Lambda. The
// shape is identical, which is why ingestDocument takes the previous version as
// an argument rather than reading storage itself.
// ---------------------------------------------------------------------------

const STATE_FILE = ".ingest-state.json";

interface IngestState {
  documentVersions: Record<string, string>;
  indexedProductIds: string[];
}

async function loadState(): Promise<IngestState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as IngestState;
  } catch {
    // No state means first run: everything is new, nothing to delete.
    return { documentVersions: {}, indexedProductIds: [] };
  }
}

async function saveState(state: IngestState): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------

console.log("INGESTION" + (dryRun ? "  (DRY RUN — nothing will be written)" : ""));

const state = await loadState();
const nextState: IngestState = {
  documentVersions: { ...state.documentVersions },
  indexedProductIds: [...state.indexedProductIds],
};

// ---- Dry run: chunk and report, touch nothing ------------------------------

if (dryRun) {
  const { chunkMarkdown, structuralContextHeader } = await import("@nailzify/core");
  const documents = await loadDocuments();

  header(1, "DOCUMENTS");
  for (const doc of documents) {
    const drafts = chunkMarkdown(doc.markdown);
    const unchanged = state.documentVersions[doc.id] === doc.version;

    console.log(`\n  ${doc.title}  (${doc.id}, ${doc.docType})`);
    line("version", `${doc.version}${unchanged ? "  — unchanged, would skip" : ""}`);
    line("chunks", drafts.length);
    line("tokens (min/median/max)", tokenSpread(drafts.map((d) => d.estimatedTokens)));

    for (const draft of drafts) {
      const head = structuralContextHeader(doc.title, draft);
      console.log(`     ${head}`);
      console.log(`       ${draft.text.replace(/\s+/g, " ").slice(0, 96)}...`);
    }
  }

  console.log("\nDRY RUN COMPLETE — no embeddings requested, no vectors written.");
  process.exit(0);
}

// ---- Real run --------------------------------------------------------------

// Model and dimension from the shared constant, never typed here — ingestion and
// query must agree exactly or the index rejects everything.
const embedder = createBedrockEmbedder({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  modelId: EMBEDDING_MODEL.modelId,
  dimensions: EMBEDDING_MODEL.dimensions,
});
const vectors = createPineconeVectorStore({
  apiKey: requireEnv("PINECONE_API_KEY"),
  indexName: requireEnv("PINECONE_INDEX"),
});

line("embedding model", embedder.modelId);
line("dimensions", embedder.dimensions);

if (only === "both" || only === "knowledge") {
  header(1, "KNOWLEDGE");
  const documents = await loadDocuments();

  for (const doc of documents) {
    const report = await ingestDocument(doc, state.documentVersions[doc.id] ?? null, {
      embedder,
      vectors,
      onProgress: (e) => {
        if (e.kind === "enrich-failed") console.log(`     enrichment degraded: ${e.reason}`);
      },
    });

    if (report.skipped) {
      console.log(`  ${doc.title.padEnd(24)} unchanged — skipped`);
    } else {
      console.log(
        `  ${doc.title.padEnd(24)} ${report.chunksWritten} chunks, ` +
          `${report.embeddingCalls} embedding call(s)`,
      );
      nextState.documentVersions[doc.id] = doc.version;
    }
  }
}

if (only === "both" || only === "products") {
  header(2, "PRODUCTS");

  const warnings: string[] = [];
  const catalog = createShopifyProductCatalog({
    client: createStorefrontClient({
      shopDomain: requireEnv("SHOPIFY_SHOP_DOMAIN"),
      accessToken: requireEnv("SHOPIFY_STOREFRONT_TOKEN"),
      // ⚠️ Shopify retires API versions after ~12 months, and a retired one
      // fails like a bad credential rather than saying the version is gone.
      apiVersion: process.env["SHOPIFY_API_VERSION"] ?? "2025-10",
    }),
    storefrontDomain: "nailzify.com",
    onWarning: (w) => warnings.push(w),
  });

  const report = await ingestProducts(
    { catalog, embedder, vectors },
    state.indexedProductIds.map(ProductId),
  );

  line("products indexed", report.productsIndexed);
  line("  of which accessories", report.accessoriesIndexed);
  line("embedding calls", report.embeddingCalls);
  line("removed (gone from Shopify)", report.removed.length);
  for (const id of report.removed) console.log(`     ${id}`);

  line("merchandising warnings", warnings.length);
  for (const w of warnings) console.log(`     ${w}`);

  // Recorded so the next run can detect deletions. Taken from the report rather
  // than a second listing — one fetch, and no chance of the two disagreeing.
  nextState.indexedProductIds = [...report.indexedIds];
}

await saveState(nextState);

console.log(`\nDONE — state written to ${STATE_FILE}`);
console.log("Verify retrieval end to end with: npx vite-node scripts/verify-retrieval.ts");

// ---------------------------------------------------------------------------

function tokenSpread(tokens: number[]): string {
  if (tokens.length === 0) return "—";
  const sorted = [...tokens].sort((a, b) => a - b);
  return `${sorted[0]} / ${sorted[Math.floor(sorted.length / 2)]} / ${sorted[sorted.length - 1]}`;
}
