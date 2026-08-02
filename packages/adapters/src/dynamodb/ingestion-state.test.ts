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
  it("is an UpdateCommand, never a PutCommand", async () => {
    // A PutCommand would wipe docType/errorMessage to null on a re-upload
    // that hits ingestPdf's cheap "skip, nothing changed" path
    // (services/ingestion/src/handler.ts), which never re-classifies.
    const { store, find } = storeWith();

    await store.recordUploadStarted({
      documentId: "doc-1",
      s3Key: "raw/uploads/doc-1.pdf",
      title: "Shipping Policy",
    });

    expect(find("PutCommand")).toBeUndefined();
    expect(find("UpdateCommand")).toBeDefined();
  });

  it("sets status, s3Key, title, timestamps and the GSI2 mirror unconditionally", async () => {
    const { store, find } = storeWith();

    await store.recordUploadStarted({
      documentId: "doc-1",
      s3Key: "raw/uploads/doc-1.pdf",
      title: "Shipping Policy",
    });

    const update = find("UpdateCommand")!;
    expect(update.input.Key).toEqual({ PK: "INGEST#UPLOAD", SK: "doc-1" });
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ":status": "processing",
      ":s3Key": "raw/uploads/doc-1.pdf",
      ":title": "Shipping Policy",
      ":pk": "INGEST#UPLOAD",
    });
    // GSI2SK leads with the timestamp so a plain query sorts by upload time —
    // no separate sort step needed when listing.
    expect(update.input.ExpressionAttributeValues[":gsi2sk"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*#doc-1$/,
    );
  });

  it("overwrites title unconditionally but only initialises docType and errorMessage if_not_exists", async () => {
    // title comes from the merchant's OWN input on this request — there is
    // nothing stale about replacing it. docType is different: it comes from
    // a PRIOR classification run, and a re-upload of unchanged content must
    // keep it rather than having ingestPdf's skip path leave it null forever.
    const { store, find } = storeWith();

    await store.recordUploadStarted({
      documentId: "doc-1",
      s3Key: "raw/uploads/doc-1.pdf",
      title: "Shipping Policy",
    });

    const expr = find("UpdateCommand")!.input.UpdateExpression as string;
    expect(expr).toMatch(/title = :title/);
    expect(expr).not.toMatch(/title = if_not_exists/);
    expect(expr).toMatch(/docType = if_not_exists\(docType, :null\)/);
    expect(expr).toMatch(/errorMessage = if_not_exists\(errorMessage, :null\)/);
  });

  it("stamps uploadedAt and updatedAt identically", async () => {
    const { store, find } = storeWith();

    await store.recordUploadStarted({
      documentId: "doc-1",
      s3Key: "raw/uploads/doc-1.pdf",
      title: "Shipping Policy",
    });

    expect(find("UpdateCommand")!.input.ExpressionAttributeValues[":now"]).toBeDefined();
    expect(find("UpdateCommand")!.input.UpdateExpression).toMatch(
      /uploadedAt = :now, updatedAt = :now/,
    );
  });
});

describe("getUploadTitle", () => {
  it("returns the title from the record", async () => {
    const { store } = storeWith({ GetCommand: { Item: { title: "Return Policy" } } });

    expect(await store.getUploadTitle("doc-1")).toBe("Return Policy");
  });

  it("returns null when the record has no title", async () => {
    // The genuinely rare case: a PDF that landed under raw/ without going
    // through the admin upload endpoint at all (a manual console upload, a
    // migration script), so recordUploadStarted never ran.
    const { store } = storeWith({ GetCommand: { Item: {} } });

    expect(await store.getUploadTitle("doc-1")).toBeNull();
  });

  it("returns null when the record does not exist", async () => {
    const { store } = storeWith({ GetCommand: {} });

    expect(await store.getUploadTitle("doc-1")).toBeNull();
  });
});

describe("recordUploadUnchanged", () => {
  it("flips status back to ready without touching title, docType or s3Key", async () => {
    // The skip path's whole point: nothing was reclassified, so nothing about
    // the document's identity should change — only its status, which
    // recordUploadStarted (wrongly, before this fix) had reset to "processing".
    const { store, find } = storeWith();

    await store.recordUploadUnchanged("doc-1");

    const update = find("UpdateCommand")!;
    expect(update.input.Key).toEqual({ PK: "INGEST#UPLOAD", SK: "doc-1" });
    expect(update.input.ExpressionAttributeValues).toEqual({
      ":status": "ready",
      ":now": expect.any(String),
    });
    expect(update.input.UpdateExpression).not.toMatch(/title|docType|s3Key|errorMessage/);
  });
});

// ---------------------------------------------------------------------------
// recordUploadReady / recordUploadFailed
// ---------------------------------------------------------------------------

describe("recordUploadReady", () => {
  it("updates status and docType without touching uploadedAt, s3Key or title", async () => {
    // ⚠️ THE REASON THIS IS AN UPDATE, NOT A PUT. A full overwrite would erase
    // the fields written by recordUploadStarted — this call runs seconds later,
    // from a different piece of code, and must not know or care what those
    // values were. title especially: it is the merchant's own "Purpose" input,
    // set once at upload time, and this write has no fresher value to offer.
    const { store, find } = storeWith();

    await store.recordUploadReady({ documentId: "doc-1", docType: "policy" });

    const update = find("UpdateCommand");
    expect(update?.input.Key).toEqual({ PK: "INGEST#UPLOAD", SK: "doc-1" });
    expect(update?.input.ExpressionAttributeValues).toMatchObject({
      ":status": "ready",
      ":docType": "policy",
    });
    expect(update?.input.UpdateExpression).not.toMatch(/uploadedAt|s3Key|title/);
  });

  it("clears any previous error message on success", async () => {
    const { store, find } = storeWith();

    await store.recordUploadReady({ documentId: "doc-1", docType: "guide" });

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
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
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
