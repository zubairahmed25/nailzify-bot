import { describe, expect, it } from "vitest";
import { ProductId } from "@nailzify/core";
import type { Embedder, Page, Product, ProductCatalog, VectorStore } from "@nailzify/core";
import { handleIngestion, type IngestionEvent } from "./handler.js";
import type { DocumentSource, IngestionDeps } from "./composition-root.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const POLICY = [
  "# Return Policy",
  "",
  "## Eligibility",
  "",
  "Items may be returned within 14 days of delivery, unopened and unused.",
].join("\n");

function deps(over: {
  files?: Record<string, string>;
  products?: Product[];
  documentVersions?: Record<string, string>;
  indexedProducts?: string[];
  warnings?: string[];
} = {}) {
  const files = over.files ?? { "raw/return-policy.md": POLICY };
  const documentVersions: Record<string, string> = { ...over.documentVersions };
  let indexedProducts = [...(over.indexedProducts ?? [])];

  const upserted: string[] = [];
  const deletedDocuments: string[] = [];
  const readKeys: string[] = [];

  const vectors: VectorStore = {
    upsert: async (_ns, records) => {
      upserted.push(...records.map((r) => r.id));
    },
    searchKnowledge: async () => [],
    searchProducts: async () => [],
    deleteByDocument: async (_ns, id) => {
      deletedDocuments.push(id);
    },
  };

  const embedder: Embedder = {
    embed: async () => [1, 0, 0],
    embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
    dimensions: 3,
    modelId: "cohere.embed-v4:0",
  };

  const catalog: ProductCatalog = {
    getByIds: async () => [],
    getByHandle: async () => null,
    listAll: async () =>
      ({ items: over.products ?? [], cursor: null }) satisfies Page<Product>,
  };

  const documents: DocumentSource = {
    list: async () => Object.keys(files),
    read: async (_bucket, key) => {
      readKeys.push(key);
      const content = files[key];
      if (content === undefined) throw new Error(`NoSuchKey: ${key}`);
      return content;
    },
  };

  const built: IngestionDeps = {
    embedder,
    vectors,
    catalog,
    documents,
    documentBucket: "docs-bucket",
    state: {
      getDocumentVersion: async (id) => documentVersions[id] ?? null,
      putDocumentVersion: async (id, version) => {
        documentVersions[id] = version;
      },
      listIndexedDocuments: async () =>
        Object.entries(documentVersions)
          .filter(([, v]) => v.length > 0)
          .map(([id]) => id),
      listIndexedProducts: async () => indexedProducts.map(ProductId),
      replaceIndexedProducts: async (ids) => {
        indexedProducts = [...ids];
      },
      // Admin-PDF-upload tracking. Not exercised by these tests yet — the
      // ingestion handler doesn't call these until the PDF path is wired up —
      // present only so this fake satisfies the interface.
      recordUploadStarted: async () => {},
      recordUploadReady: async () => {},
      recordUploadFailed: async () => {},
      deleteUploadRecord: async () => {},
      listUploadedDocuments: async () => [],
    },
    drainWarnings: () => over.warnings ?? [],
  };

  return { deps: built, upserted, deletedDocuments, readKeys, documentVersions };
}

const s3Event = (eventName: string, key: string): IngestionEvent => ({
  Records: [{ eventName, s3: { bucket: { name: "docs-bucket" }, object: { key } } }],
});

// ---------------------------------------------------------------------------

describe("S3 object keys", () => {
  it("decodes a key with a space in it", async () => {
    // ⚠️ S3 event notifications percent-encode keys AND turn spaces into "+".
    // Reading the raw key looks up "size+guide.md", which 404s. The bug only
    // appears for filenames containing spaces, which is exactly the kind a
    // non-engineer uploading through the console will produce.
    const d = deps({ files: { "raw/size guide.md": POLICY } });

    await handleIngestion(s3Event("ObjectCreated:Put", "raw/size+guide.md"), d.deps);

    expect(d.readKeys).toEqual(["raw/size guide.md"]);
  });

  it("decodes percent-encoded characters", async () => {
    const d = deps({ files: { "raw/faq & help.md": POLICY } });

    await handleIngestion(s3Event("ObjectCreated:Put", "raw/faq+%26+help.md"), d.deps);

    expect(d.readKeys).toEqual(["raw/faq & help.md"]);
  });

  it("derives the document id from the filename, not the full key", async () => {
    const d = deps({ files: { "raw/policies/return-policy.md": POLICY } });

    const result = await handleIngestion(
      s3Event("ObjectCreated:Put", "raw/policies/return-policy.md"),
      d.deps,
    );

    expect(result.documents[0]!.documentId).toBe("return-policy");
  });
});

describe("deleting a document", () => {
  it("purges the vectors when the object is removed", async () => {
    // Deleting the S3 object does NOT remove vectors on its own. Without this
    // the bot keeps quoting a policy the store no longer has — worse than having
    // no policy, because it is confidently wrong.
    const d = deps({ documentVersions: { "return-policy": "abc123" } });

    const result = await handleIngestion(
      s3Event("ObjectRemoved:Delete", "raw/return-policy.md"),
      d.deps,
    );

    expect(d.deletedDocuments).toEqual(["return-policy"]);
    expect(result.documents[0]!.action).toBe("removed");
  });

  it("does not try to read an object that was just deleted", async () => {
    const d = deps({ files: {} });

    await handleIngestion(s3Event("ObjectRemoved:Delete", "raw/return-policy.md"), d.deps);

    expect(d.readKeys).toEqual([]);
  });

  it("clears the recorded version so a redelivered event is a no-op", async () => {
    // S3 notifications are at-least-once. A second delete must not resurrect
    // work, and the document must not look indexed to the next reconciliation.
    const d = deps({ documentVersions: { "return-policy": "abc123" } });

    await handleIngestion(s3Event("ObjectRemoved:Delete", "raw/return-policy.md"), d.deps);

    expect(d.documentVersions["return-policy"]).toBe("");
  });
});

describe("choosing what to ingest", () => {
  it("ignores a file type it cannot read, with a warning", async () => {
    // The PDFs in data/documents/pdf are GENERATED from the markdown beside
    // them. Ingesting one would extract text from a file we produced from text
    // we already have — a lossy round trip for no gain.
    const d = deps({ files: {} });

    const result = await handleIngestion(
      s3Event("ObjectCreated:Put", "raw/nailzify-size-guide.pdf"),
      d.deps,
    );

    expect(result.documents).toEqual([]);
    expect(result.warnings.some((w) => w.includes("not an ingestible"))).toBe(true);
    expect(d.readKeys).toEqual([]);
  });

  it("skips a document whose content has not changed", async () => {
    const first = deps();
    await handleIngestion({ mode: "documents" }, first.deps);
    const versionAfterFirst = first.documentVersions["return-policy"];

    const second = deps({ documentVersions: { "return-policy": versionAfterFirst! } });
    const result = await handleIngestion({ mode: "documents" }, second.deps);

    expect(result.documents[0]!.action).toBe("skipped");
    expect(second.upserted).toEqual([]);
  });

  it("records the version only after the write succeeds", async () => {
    // Recording first would make a failed run look complete to the next one,
    // which would then skip the document that never got indexed.
    const d = deps();
    const exploding = {
      ...d.deps,
      vectors: {
        ...d.deps.vectors,
        upsert: async () => {
          throw new Error("Pinecone unavailable");
        },
      },
    };

    await expect(handleIngestion({ mode: "documents" }, exploding)).rejects.toThrow();
    expect(d.documentVersions["return-policy"]).toBeUndefined();
  });
});

describe("reconciliation", () => {
  it("purges vectors for a document whose object disappeared", async () => {
    // Catches deletes whose ObjectRemoved notification was never delivered — a
    // real possibility, since S3 notifications are at-least-once, not exactly-once.
    const d = deps({
      files: { "raw/return-policy.md": POLICY },
      documentVersions: { "shipping-policy": "old-version" },
    });

    const result = await handleIngestion({ mode: "documents" }, d.deps);

    expect(d.deletedDocuments).toContain("shipping-policy");
    expect(result.documents.some((r) => r.documentId === "shipping-policy" && r.action === "removed")).toBe(
      true,
    );
  });

  it("leaves live documents alone", async () => {
    // NOTE the assertion is on the reported ACTION, not on deleteByDocument
    // calls. Re-ingesting a changed document legitimately deletes its old
    // vectors before writing the new ones — that is the replace step in
    // ingestDocument. An earlier version of this test watched the raw calls and
    // could not tell "replaced" from "purged as an orphan".
    const d = deps({
      files: { "raw/return-policy.md": POLICY },
      documentVersions: { "return-policy": "stale" },
    });

    const result = await handleIngestion({ mode: "documents" }, d.deps);

    expect(result.documents).toEqual([
      { documentId: "return-policy", action: "indexed", chunks: expect.any(Number) },
    ]);
    expect(d.documentVersions["return-policy"]).not.toBe("");
  });
});

describe("modes", () => {
  it("touches only documents in documents mode", async () => {
    const d = deps({ indexedProducts: ["gid://shopify/Product/1"] });

    const result = await handleIngestion({ mode: "documents" }, d.deps);

    expect(result.products).toBeNull();
    expect(result.documents.length).toBeGreaterThan(0);
  });

  it("touches only products in products mode", async () => {
    const d = deps({ products: [] });

    // An empty catalogue is refused rather than treated as "delete everything".
    await expect(handleIngestion({ mode: "products" }, d.deps)).rejects.toThrow(/zero products/);
    expect(d.upserted).toEqual([]);
  });

  it("passes merchandising warnings through", async () => {
    const d = deps({ warnings: ['"Snowflake Wishes": no shape metafield (custom.nail_text)'] });

    const result = await handleIngestion({ mode: "documents" }, d.deps);

    expect(result.warnings).toContain('"Snowflake Wishes": no shape metafield (custom.nail_text)');
  });
});

// ---------------------------------------------------------------------------
// EventBridge — the shape the DEPLOYED bucket actually sends
// ---------------------------------------------------------------------------

const ebEvent = (detailType: string, key: string): IngestionEvent => ({
  source: "aws.s3",
  "detail-type": detailType,
  detail: { bucket: { name: "docs-bucket" }, object: { key } },
});

describe("EventBridge delivery", () => {
  it("indexes a created object", async () => {
    const d = deps({ files: { "raw/return-policy.md": POLICY } });

    const result = await handleIngestion(ebEvent("Object Created", "raw/return-policy.md"), d.deps);

    expect(result.documents[0]).toMatchObject({ documentId: "return-policy", action: "indexed" });
  });

  it("purges vectors on Object Deleted", async () => {
    const d = deps({ documentVersions: { "return-policy": "abc123" } });

    await handleIngestion(ebEvent("Object Deleted", "raw/return-policy.md"), d.deps);

    expect(d.deletedDocuments).toEqual(["return-policy"]);
  });

  it("does NOT url-decode an EventBridge key", async () => {
    // ⚠️ THE TWO SOURCES DIFFER. A bucket notification percent-encodes the key
    // and turns spaces into "+"; EventBridge sends it verbatim. Decoding an
    // EventBridge key would corrupt any filename containing a legitimate "+" or
    // "%" — and "size+guide.md" is a name a person genuinely types.
    const d = deps({ files: { "raw/size+guide.md": POLICY } });

    await handleIngestion(ebEvent("Object Created", "raw/size+guide.md"), d.deps);

    expect(d.readKeys).toEqual(["raw/size+guide.md"]);
  });

  it("still url-decodes a bucket-notification key", async () => {
    // The other half of the same rule, so neither can be "fixed" into the other.
    const d = deps({ files: { "raw/size guide.md": POLICY } });

    await handleIngestion(s3Event("ObjectCreated:Put", "raw/size+guide.md"), d.deps);

    expect(d.readKeys).toEqual(["raw/size guide.md"]);
  });

  it("is not mistaken for a mode event", async () => {
    const d = deps({ files: { "raw/return-policy.md": POLICY } });

    const result = await handleIngestion(ebEvent("Object Created", "raw/return-policy.md"), d.deps);

    // A products sync must not run just because a document changed.
    expect(result.products).toBeNull();
  });
});
