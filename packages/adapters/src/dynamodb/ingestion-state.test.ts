import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createIngestionStateStore } from "./ingestion-state.js";

const TABLE = "nailzify-test";

/** Captures the command DynamoDB would have received. */
interface Sent {
  readonly name: string;
  readonly input: Record<string, any>;
}

function fakeClient(responses: Record<string, unknown> = {}) {
  const sent: Sent[] = [];

  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    const name = command.constructor.name;
    sent.push({ name, input: command.input as Record<string, any> });
    return responses[name] ?? {};
  });

  return { client: { send } as unknown as DynamoDBDocumentClient, sent };
}

const storeWith = (responses: Record<string, unknown> = {}) => {
  const fake = fakeClient(responses);
  return {
    store: createIngestionStateStore({ tableName: TABLE, client: fake.client }),
    sent: fake.sent,
    find: (name: string) => fake.sent.find((s) => s.name === name),
  };
};

// ---------------------------------------------------------------------------
// recordUploadStarted
// ---------------------------------------------------------------------------

describe("recordUploadStarted", () => {
  it("writes a processing record with the GSI mirror for sorting", async () => {
    const { store, find } = storeWith();

    await store.recordUploadStarted({ documentId: "doc-1", s3Key: "raw/uploads/doc-1.pdf" });

    const put = find("PutCommand");
    expect(put?.input.Item).toMatchObject({
      PK: "INGEST#UPLOAD",
      SK: "doc-1",
      GSI1PK: "INGEST#UPLOAD",
      status: "processing",
      title: null,
      docType: null,
      errorMessage: null,
      s3Key: "raw/uploads/doc-1.pdf",
    });
    // GSI1SK leads with the timestamp so a plain query sorts by upload time —
    // no separate sort step needed when listing.
    expect(put?.input.Item.GSI1SK).toMatch(/^\d{4}-\d{2}-\d{2}T.*#doc-1$/);
  });

  it("stamps uploadedAt and updatedAt identically on creation", async () => {
    const { store, find } = storeWith();

    await store.recordUploadStarted({ documentId: "doc-1", s3Key: "raw/uploads/doc-1.pdf" });

    const item = find("PutCommand")?.input.Item;
    expect(item.uploadedAt).toBe(item.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// recordUploadReady / recordUploadFailed
// ---------------------------------------------------------------------------

describe("recordUploadReady", () => {
  it("updates status, title and docType without touching uploadedAt or s3Key", async () => {
    // ⚠️ THE REASON THIS IS AN UPDATE, NOT A PUT. A full overwrite would erase
    // the fields written by recordUploadStarted — this call runs seconds later,
    // from a different piece of code, and must not know or care what those
    // values were.
    const { store, find } = storeWith();

    await store.recordUploadReady({
      documentId: "doc-1",
      title: "Shipping Policy",
      docType: "policy",
    });

    const update = find("UpdateCommand");
    expect(update?.input.Key).toEqual({ PK: "INGEST#UPLOAD", SK: "doc-1" });
    expect(update?.input.ExpressionAttributeValues).toMatchObject({
      ":status": "ready",
      ":title": "Shipping Policy",
      ":docType": "policy",
    });
    expect(update?.input.UpdateExpression).not.toMatch(/uploadedAt|s3Key/);
  });

  it("clears any previous error message on success", async () => {
    const { store, find } = storeWith();

    await store.recordUploadReady({ documentId: "doc-1", title: "x", docType: "guide" });

    expect(find("UpdateCommand")?.input.ExpressionAttributeValues[":noError"]).toBeNull();
  });
});

describe("recordUploadFailed", () => {
  it("sets status to failed with the given message", async () => {
    const { store, find } = storeWith();

    await store.recordUploadFailed({
      documentId: "doc-1",
      errorMessage: "couldn't read any text from this PDF",
    });

    const update = find("UpdateCommand");
    expect(update?.input.ExpressionAttributeValues).toMatchObject({
      ":status": "failed",
      ":error": "couldn't read any text from this PDF",
    });
  });

  it("does not touch title or docType", async () => {
    // A failed extraction never learned a title. Leaving those fields alone
    // rather than nulling them means a RETRY that fixes the problem is not
    // fighting a failure path that already wiped the previous good values.
    const { store, find } = storeWith();

    await store.recordUploadFailed({ documentId: "doc-1", errorMessage: "boom" });

    expect(find("UpdateCommand")?.input.UpdateExpression).not.toMatch(/title|docType/);
  });
});

// ---------------------------------------------------------------------------
// deleteUploadRecord
// ---------------------------------------------------------------------------

describe("deleteUploadRecord", () => {
  it("deletes by the same key uploads are stored under", async () => {
    const { store, find } = storeWith();

    await store.deleteUploadRecord("doc-1");

    expect(find("DeleteCommand")?.input.Key).toEqual({ PK: "INGEST#UPLOAD", SK: "doc-1" });
  });
});

// ---------------------------------------------------------------------------
// listUploadedDocuments
// ---------------------------------------------------------------------------

describe("listUploadedDocuments", () => {
  it("queries the GSI newest-first", async () => {
    const { store, find } = storeWith({
      QueryCommand: {
        Items: [
          {
            PK: "INGEST#UPLOAD",
            SK: "doc-2",
            status: "ready",
            title: "Return Policy",
            docType: "policy",
            errorMessage: null,
            s3Key: "raw/uploads/doc-2.pdf",
            uploadedAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:05.000Z",
          },
        ],
      },
    });

    const results = await store.listUploadedDocuments();

    expect(find("QueryCommand")?.input).toMatchObject({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "INGEST#UPLOAD" },
      ScanIndexForward: false,
    });
    expect(results).toEqual([
      {
        documentId: "doc-2",
        status: "ready",
        title: "Return Policy",
        docType: "policy",
        errorMessage: null,
        s3Key: "raw/uploads/doc-2.pdf",
        uploadedAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:05.000Z",
      },
    ]);
  });

  it("returns an empty list rather than throwing when nothing has been uploaded", async () => {
    const { store } = storeWith({ QueryCommand: {} });
    expect(await store.listUploadedDocuments()).toEqual([]);
  });

  it("does not let one document with an unrecognised status break the whole list", async () => {
    // A status the admin page doesn't know how to render is a display bug, not
    // a reason the merchant can't see their OTHER documents.
    const { store } = storeWith({
      QueryCommand: {
        Items: [
          {
            PK: "INGEST#UPLOAD",
            SK: "doc-3",
            status: "some-future-status-this-code-does-not-know-about",
            title: null,
            docType: null,
            errorMessage: null,
            s3Key: "raw/uploads/doc-3.pdf",
            uploadedAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      },
    });

    const [doc] = await store.listUploadedDocuments();
    expect(doc?.status).toBe("processing");
  });

  it("follows pagination until every page is collected", async () => {
    const responses = [
      {
        Items: [{ PK: "INGEST#UPLOAD", SK: "doc-a", status: "ready" }],
        LastEvaluatedKey: { PK: "INGEST#UPLOAD", SK: "doc-a" },
      },
      { Items: [{ PK: "INGEST#UPLOAD", SK: "doc-b", status: "ready" }] },
    ];
    let call = 0;
    const send = vi.fn(async () => responses[call++]);
    const store = createIngestionStateStore({
      tableName: TABLE,
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    const results = await store.listUploadedDocuments();

    expect(send).toHaveBeenCalledTimes(2);
    expect(results.map((d) => d.documentId)).toEqual(["doc-a", "doc-b"]);
  });
});
