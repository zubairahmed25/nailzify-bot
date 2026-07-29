import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The SDK is mocked because these tests are about ERROR HANDLING, and the errors
// in question only occur against a real index in states that are awkward to
// reach on purpose — a namespace that has never been written to, or a filtered
// delete that silently matches nothing.
// ---------------------------------------------------------------------------

const namespaceApi = {
  upsert: vi.fn(async () => {}),
  query: vi.fn(async () => ({ matches: [] })),
  deleteMany: vi.fn(async () => {}),
};

const indexApi = {
  namespace: vi.fn(() => namespaceApi),
  describeIndexStats: vi.fn(
    async () => ({}) as { namespaces?: Record<string, { recordCount: number }> },
  ),
};

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: class {
    index() {
      return indexApi;
    }
  },
}));

const { createPineconeVectorStore } = await import("./vector-store.js");

const notFound = () =>
  Object.assign(
    new Error("A call to https://x.pinecone.io/vectors/delete returned HTTP status 404."),
    { name: "PineconeNotFoundError" },
  );

const store = () => createPineconeVectorStore({ apiKey: "test", indexName: "nailzify-test" });

beforeEach(() => {
  vi.clearAllMocks();
  namespaceApi.deleteMany.mockImplementation(async () => {});
  indexApi.describeIndexStats.mockImplementation(async () => ({}));
});

// ---------------------------------------------------------------------------
// The failure that took down the very first real ingestion run
// ---------------------------------------------------------------------------

describe("deleting from a namespace that does not exist", () => {
  it("treats a 404 on an empty namespace as a no-op", async () => {
    // THE FIRST-RUN CASE. A brand-new index has no namespaces, and
    // ingestDocument deletes before it upserts — so the very first operation of
    // every new deployment hits this. Deleting nothing from nothing already has
    // the desired end state; a delete is idempotent by nature.
    namespaceApi.deleteMany.mockRejectedValueOnce(notFound());
    indexApi.describeIndexStats.mockResolvedValueOnce({ namespaces: {} });

    await expect(store().deleteByDocument("knowledge", "return-policy")).resolves.toBeUndefined();
  });

  it("throws when the same 404 comes from a namespace that is NOT empty", async () => {
    // The dangerous reading of an identical error: delete-by-metadata-filter is
    // not working. Swallowing that would leave the previous version's chunks in
    // place on every re-ingest — the index accumulating stale duplicates of every
    // document, the bot quoting superseded policies, and no error or failing test
    // anywhere to show for it.
    namespaceApi.deleteMany.mockRejectedValueOnce(notFound());
    indexApi.describeIndexStats.mockResolvedValueOnce({
      namespaces: { knowledge: { recordCount: 7 } },
    });

    await expect(store().deleteByDocument("knowledge", "return-policy")).rejects.toThrow(
      /not empty, so this is not a first-run no-op/,
    );
  });

  it("checks the stats only on the error path", async () => {
    // A successful delete must not pay for an extra round trip.
    await store().deleteByDocument("knowledge", "return-policy");

    expect(namespaceApi.deleteMany).toHaveBeenCalledOnce();
    expect(indexApi.describeIndexStats).not.toHaveBeenCalled();
  });

  it("still surfaces a non-404 failure", async () => {
    namespaceApi.deleteMany.mockRejectedValueOnce(
      new Error("PineconeAuthorizationError: invalid API key"),
    );

    await expect(store().deleteByDocument("knowledge", "return-policy")).rejects.toThrow(
      /Pinecone delete failed/,
    );
    expect(indexApi.describeIndexStats).not.toHaveBeenCalled();
  });

  it("recognises a 404 reported without the SDK error class", async () => {
    // The SDK does not export PineconeNotFoundError from its package root, so the
    // check is structural. A plain error mentioning 404 must still match, or an
    // SDK internal reshuffle silently turns first runs back into hard failures.
    namespaceApi.deleteMany.mockRejectedValueOnce(new Error("returned HTTP status 404."));
    indexApi.describeIndexStats.mockResolvedValueOnce({ namespaces: {} });

    await expect(
      store().deleteByDocument("products", "gid://shopify/Product/1"),
    ).resolves.toBeUndefined();
  });
});

describe("upsert", () => {
  it("makes no call for an empty record set", async () => {
    await store().upsert("knowledge", []);
    expect(namespaceApi.upsert).not.toHaveBeenCalled();
  });

  it("batches large upserts rather than sending one huge payload", async () => {
    const records = Array.from({ length: 250 }, (_, i) => ({
      id: `c${i}`,
      values: [1, 0, 0],
      metadata: { documentId: "d" },
    }));

    await store().upsert("knowledge", records);

    // 250 records at 100 per call. Pinecone caps payload size, and batching also
    // bounds the blast radius of one failed request during a bulk re-index.
    expect(namespaceApi.upsert).toHaveBeenCalledTimes(3);
  });
});
