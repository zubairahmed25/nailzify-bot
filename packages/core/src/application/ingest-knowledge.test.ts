import { describe, expect, it, vi } from "vitest";
import { DocumentId } from "../domain/shared/brand.js";
import type { Embedder, KnowledgeRepository, VectorStore } from "../ports/index.js";
import { EmptyDocumentError, ingestDocument, type SourceDocument } from "./ingest-knowledge.js";

// ---------------------------------------------------------------------------
// Fakes that record what happened, in what order
// ---------------------------------------------------------------------------

function deps(over: { embedder?: Partial<Embedder> } = {}) {
  const calls: string[] = [];

  const embedder: Embedder = {
    embed: async () => [1, 0, 0],
    embedBatch: async (texts) => {
      calls.push("embed");
      return texts.map(() => [1, 0, 0]);
    },
    dimensions: 3,
    modelId: "cohere.embed-v4:0",
    ...over.embedder,
  };

  const upserted: { id: string; metadata: Record<string, unknown> }[] = [];
  const embeddedTexts: string[] = [];

  const vectors: VectorStore = {
    upsert: async (_ns, records) => {
      calls.push("upsert");
      upserted.push(...records.map((r) => ({ id: r.id, metadata: r.metadata })));
    },
    searchKnowledge: async () => [],
    searchProducts: async () => [],
    deleteByDocument: async () => {
      calls.push("delete");
    },
  };

  const stored: { id: string; text: string; contextHeader: string | null }[] = [];
  const knowledge: KnowledgeRepository = {
    putChunks: async (chunks) => {
      calls.push("putChunks");
      stored.push(...chunks.map((c) => ({ id: c.id, text: c.text, contextHeader: c.contextHeader })));
    },
    getChunks: async () => [],
  };

  const spyEmbedder: Embedder = {
    ...embedder,
    embedBatch: async (texts, purpose) => {
      embeddedTexts.push(...texts);
      return embedder.embedBatch(texts, purpose);
    },
  };

  return { embedder: spyEmbedder, vectors, knowledge, calls, upserted, stored, embeddedTexts };
}

const doc = (over: Partial<SourceDocument> = {}): SourceDocument => ({
  id: DocumentId("return-policy"),
  title: "Return Policy",
  docType: "policy",
  markdown: [
    "# Return Policy",
    "",
    "## Eligibility",
    "",
    "Items may be returned within 30 days of delivery, unopened and unused.",
    "",
    "## Refunds",
    "",
    "Refunds are issued to the original payment method within 5 business days.",
  ].join("\n"),
  version: "2026-07-01",
  ...over,
});

// ---------------------------------------------------------------------------
// The ordering guarantee — the reason this file is shaped the way it is
// ---------------------------------------------------------------------------

describe("failure must never destroy a good document", () => {
  it("does not delete anything when embedding fails", async () => {
    // THE BUG THIS ORDER PREVENTS. Delete-then-embed leaves the document missing
    // from the index when Bedrock throttles, and the bot starts answering "I
    // don't have information about returns" with nothing raised anywhere.
    const d = deps({
      embedder: {
        embedBatch: async () => {
          throw new Error("ThrottlingException");
        },
      },
    });

    await expect(ingestDocument(doc(), null, d)).rejects.toThrow("ThrottlingException");

    expect(d.calls).not.toContain("delete");
    expect(d.calls).not.toContain("upsert");
  });

  it("deletes only after every vector is in hand", async () => {
    const d = deps();

    await ingestDocument(doc(), null, d);

    // Every embed call precedes the delete. Stale beats absent.
    expect(d.calls.indexOf("delete")).toBeGreaterThan(d.calls.lastIndexOf("embed"));
    expect(d.calls.indexOf("upsert")).toBeGreaterThan(d.calls.indexOf("delete"));
  });

  it("refuses an empty document instead of emptying the index", async () => {
    // An empty document is nearly always a failed extraction — a PDF that
    // yielded no text. Treating it as "the document is now empty" deletes
    // perfectly good chunks because an upstream step failed quietly.
    const d = deps();

    await expect(ingestDocument(doc({ markdown: "   " }), null, d)).rejects.toBeInstanceOf(
      EmptyDocumentError,
    );
    expect(d.calls).toEqual([]);
  });

  it("refuses when the embedder returns the wrong number of vectors", async () => {
    // Misalignment pairs every subsequent chunk with another chunk's vector.
    // Retrieval still "works" and returns confident nonsense.
    const d = deps({ embedder: { embedBatch: async () => [[1, 0, 0]] } });

    await expect(ingestDocument(doc(), null, d)).rejects.toThrow(/vectors for/);
    expect(d.calls).not.toContain("delete");
  });

  it("refuses when the embedder returns the wrong dimensions", async () => {
    // Cohere embed-v4 defaults to 1536 and we pin 1024. If the pin ever stops
    // applying, failing here names the cause instead of surfacing as an opaque
    // index-dimension rejection.
    const d = deps({
      embedder: { embedBatch: async (t) => t.map(() => [1, 0, 0, 0, 0]) },
    });

    await expect(ingestDocument(doc(), null, d)).rejects.toThrow(/declares 3 dimensions/);
    expect(d.calls).not.toContain("delete");
  });
});

// ---------------------------------------------------------------------------

describe("skipping unchanged documents", () => {
  it("does no work at all when the version is unchanged", async () => {
    const d = deps();

    const report = await ingestDocument(doc({ version: "v1" }), "v1", d);

    expect(report.skipped).toBe(true);
    expect(report.chunksWritten).toBe(0);
    // Not just cheaper — it means no delete, so no window where the document is
    // missing from the index.
    expect(d.calls).toEqual([]);
  });

  it("re-ingests when the version moved", async () => {
    const d = deps();

    const report = await ingestDocument(doc({ version: "v2" }), "v1", d);

    expect(report.skipped).toBe(false);
    expect(report.chunksWritten).toBeGreaterThan(0);
  });

  it("re-ingests when there is no previous version", async () => {
    const d = deps();
    expect((await ingestDocument(doc(), null, d)).skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("what gets embedded and what gets stored", () => {
  it("embeds the context header but stores the text alone", async () => {
    // The header is a retrieval aid. Storing it would leak internal scaffolding
    // into an answer a customer reads.
    const d = deps();

    await ingestDocument(doc(), null, d);

    expect(d.embeddedTexts.some((t) => t.includes("[Return Policy"))).toBe(true);
    expect(d.stored.every((c) => !c.text.includes("[Return Policy"))).toBe(true);
    expect(d.stored.every((c) => c.contextHeader !== null)).toBe(true);
  });

  it("gives a chunk the same id across re-ingest", async () => {
    // Position-derived ids mean an edit overwrites in place rather than leaving
    // the old vector orphaned beside the new one.
    const first = deps();
    await ingestDocument(doc({ version: "v1" }), null, first);

    const second = deps();
    await ingestDocument(doc({ version: "v2" }), "v1", second);

    expect(second.upserted.map((r) => r.id)).toEqual(first.upserted.map((r) => r.id));
  });

  it("stamps every chunk with the document version and embedding model", async () => {
    const d = deps();

    await ingestDocument(doc({ version: "2026-07-01" }), null, d);

    expect(d.upserted.every((r) => r.metadata["version"] === "2026-07-01")).toBe(true);
    expect(d.upserted.every((r) => r.metadata["embeddingModel"] === "cohere.embed-v4:0")).toBe(true);
  });

  it("writes the chunk text to the repository, not only to vector metadata", async () => {
    const d = deps();

    await ingestDocument(doc(), null, d);

    expect(d.stored.length).toBe(d.upserted.length);
    expect(d.stored.some((c) => c.text.includes("30 days"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("context enrichment degrades rather than fails", () => {
  it("falls back to structural headers when the enricher throws", async () => {
    // A document with structural headers is worse than one with generated
    // headers. A document missing entirely is worse than both.
    const d = deps();

    const report = await ingestDocument(doc(), null, {
      ...d,
      enricher: {
        enrich: async () => {
          throw new Error("model unavailable");
        },
      },
    });

    expect(report.enrichmentDegraded).toBe(true);
    expect(report.chunksWritten).toBeGreaterThan(0);
    expect(d.stored.every((c) => c.contextHeader?.startsWith("[Return Policy"))).toBe(true);
  });

  it("uses the generated header when enrichment succeeds", async () => {
    const d = deps();

    await ingestDocument(doc(), null, {
      ...d,
      enricher: { enrich: async () => "This clause sets the 30-day return window." },
    });

    expect(d.stored.every((c) => c.contextHeader === "This clause sets the 30-day return window.")).toBe(
      true,
    );
  });

  it("falls back when the enricher returns a blank string", async () => {
    // A blank result is a failed generation, not a valid header.
    const d = deps();

    await ingestDocument(doc(), null, { ...d, enricher: { enrich: async () => "   " } });

    expect(d.stored.every((c) => c.contextHeader?.startsWith("[Return Policy"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("batching", () => {
  it("splits large documents across multiple embedding calls", async () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `## Section ${i}\n\nSome policy text for section ${i}. `.repeat(4),
    ).join("\n\n");
    const d = deps();

    const report = await ingestDocument(doc({ markdown: many }), null, { ...d, batchSize: 5 });

    expect(report.embeddingCalls).toBeGreaterThan(1);
    expect(report.chunksWritten).toBeGreaterThan(5);
  });

  it("uses one call for a small document", async () => {
    const d = deps();
    expect((await ingestDocument(doc(), null, d)).embeddingCalls).toBe(1);
  });
});
