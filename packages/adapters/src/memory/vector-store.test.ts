import { describe, expect, it } from "vitest";
import { ChunkId, DocumentId, ProductId, type VectorRecord } from "@nailzify/core";
import { cosineSimilarity, createInMemoryVectorStore } from "./vector-store.js";

// Hand-built 3-dimensional vectors. Real embeddings are 1024-d and opaque; tiny
// ones let us assert on similarity with geometry we can reason about by hand.
const NORTH: readonly number[] = [1, 0, 0];
const NORTH_ISH: readonly number[] = [0.9, 0.1, 0];
const EAST: readonly number[] = [0, 1, 0];

describe("cosineSimilarity", () => {
  it("returns 1 for identical direction", () => {
    expect(cosineSimilarity(NORTH, NORTH)).toBeCloseTo(1);
  });

  it("ignores magnitude, only direction", () => {
    // The property that makes a two-word query match a 500-word passage:
    // magnitude tracks length, direction carries meaning.
    expect(cosineSimilarity([1, 0, 0], [100, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(NORTH, EAST)).toBeCloseTo(0);
  });

  it("ranks a near-match above an unrelated one", () => {
    expect(cosineSimilarity(NORTH, NORTH_ISH)).toBeGreaterThan(
      cosineSimilarity(NORTH, EAST),
    );
  });

  it("handles a zero vector without dividing by zero", () => {
    expect(cosineSimilarity([0, 0, 0], NORTH)).toBe(0);
  });

  it("rejects a dimension mismatch loudly", () => {
    // Silent truncation here would produce plausible-but-wrong scores, which is
    // far worse than a crash. This is exactly the bug the verified 1536-vs-1024
    // finding would have caused.
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(TypeError);
  });
});

function knowledgeRecord(id: string, values: readonly number[], meta: Record<string, unknown> = {}): VectorRecord {
  return {
    id,
    values,
    metadata: {
      documentId: "returns-policy",
      title: "Return Policy",
      section: "Eligibility",
      docType: "policy",
      text: `Text for ${id}`,
      version: "2026-03-01",
      embeddingModel: "cohere.embed-v4:0",
      ...meta,
    },
  };
}

describe("in-memory vector store", () => {
  it("round-trips an upsert and a search", async () => {
    const store = createInMemoryVectorStore();
    await store.upsert("knowledge", [
      knowledgeRecord("a", NORTH),
      knowledgeRecord("b", EAST),
    ]);

    const results = await store.searchKnowledge(NORTH, 2);

    expect(results[0]!.chunk.id).toBe(ChunkId("a"));
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("overwrites on repeated upsert instead of duplicating", async () => {
    // Deterministic ids are what make a half-failed ingest safe to retry.
    const store = createInMemoryVectorStore();
    await store.upsert("knowledge", [knowledgeRecord("a", NORTH)]);
    await store.upsert("knowledge", [knowledgeRecord("a", EAST)]);

    expect(store.size("knowledge")).toBe(1);
  });

  it("keeps namespaces isolated", async () => {
    const store = createInMemoryVectorStore();
    await store.upsert("knowledge", [knowledgeRecord("a", NORTH)]);
    await store.upsert("products", [
      { id: "p1", values: NORTH, metadata: { productId: "gid://shopify/Product/1" } },
    ]);

    expect(await store.searchKnowledge(NORTH, 10)).toHaveLength(1);
    expect(await store.searchProducts(NORTH, 10)).toHaveLength(1);
  });

  it("applies metadata filters before ranking", async () => {
    const store = createInMemoryVectorStore();
    await store.upsert("knowledge", [
      knowledgeRecord("policy", NORTH, { docType: "policy" }),
      knowledgeRecord("guide", NORTH, { docType: "guide" }),
    ]);

    const results = await store.searchKnowledge(NORTH, 10, { docType: "guide" });

    expect(results).toHaveLength(1);
    expect(results[0]!.chunk.id).toBe(ChunkId("guide"));
  });

  it("deletes surgically by document", async () => {
    // Updating one policy must not require rebuilding the whole index.
    const store = createInMemoryVectorStore();
    await store.upsert("knowledge", [
      knowledgeRecord("r1", NORTH, { documentId: "returns-policy" }),
      knowledgeRecord("s1", EAST, { documentId: "shipping-policy" }),
    ]);

    await store.deleteByDocument("knowledge", "returns-policy");

    const remaining = await store.searchKnowledge(NORTH, 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.chunk.documentId).toBe(DocumentId("shipping-policy"));
  });

  it("respects topK", async () => {
    const store = createInMemoryVectorStore();
    await store.upsert(
      "knowledge",
      Array.from({ length: 10 }, (_, i) => knowledgeRecord(`c${i}`, NORTH)),
    );

    expect(await store.searchKnowledge(NORTH, 3)).toHaveLength(3);
  });
});

describe("product candidates carry no price", () => {
  it("drops a price even if one leaks into vector metadata", async () => {
    // Defence in depth. The metadata here deliberately contains a price, as a
    // careless ingest might. ProductCandidate has nowhere to put it, so it
    // cannot reach the domain. The type IS the enforcement.
    const store = createInMemoryVectorStore();
    await store.upsert("products", [
      {
        id: "p1",
        values: NORTH,
        metadata: {
          productId: "gid://shopify/Product/8123",
          shape: "almond",
          priceBand: "15-25",
          price: "18.00", // <- should never escape the adapter
          inventoryQuantity: 12, // <- nor this
        },
      },
    ]);

    const [candidate] = await store.searchProducts(NORTH, 1);

    expect(candidate!.productId).toBe(ProductId("gid://shopify/Product/8123"));
    expect(candidate!.priceBand).toBe("15-25");
    expect(Object.keys(candidate!)).toEqual(["productId", "score", "priceBand", "attributes"]);
    expect(JSON.stringify(candidate)).not.toContain("18.00");
  });

  it("filters candidates by price band", async () => {
    const store = createInMemoryVectorStore();
    await store.upsert("products", [
      { id: "cheap", values: NORTH, metadata: { productId: "1", priceBand: "under-15" } },
      { id: "pricey", values: NORTH, metadata: { productId: "2", priceBand: "25-plus" } },
    ]);

    const results = await store.searchProducts(NORTH, 10, {
      priceBands: ["under-15", "15-25"],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.productId).toBe(ProductId("1"));
  });
});
