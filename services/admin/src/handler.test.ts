import { describe, expect, it } from "vitest";
import type { UploadedDocument } from "@nailzify/adapters";
import type { AdminDeps, UploadSlot } from "./composition-root.js";
import { handleAdminRequest, type AdminEvent } from "./handler.js";
import { signSessionTokenForTest } from "./security/verify-session-token.js";

const SECRET = "shpss_test_secret_value";
const API_KEY = "12345test-api-key";
const SHOP_DOMAIN = "nailzify.myshopify.com";
const DEST = `https://${SHOP_DOMAIN}`;

// Clock-edge cases (expiry, not-before, skew tolerance) belong to
// verify-session-token.test.ts, which injects a fake clock. This file only
// exercises routing and wiring, so the token just needs to be valid against
// the REAL clock `handleAdminRequest` actually uses.
const nowSeconds = () => Math.floor(Date.now() / 1000);

const validToken = signSessionTokenForTest(
  {
    iss: `${DEST}/admin`,
    dest: DEST,
    aud: API_KEY,
    sub: "merchant-user-1",
    exp: nowSeconds() + 3600,
    nbf: nowSeconds() - 60,
  },
  SECRET,
);

interface DepsOptions {
  readonly documents?: readonly UploadedDocument[];
  readonly createUploadSlotResult?: UploadSlot;
}

function deps(options: DepsOptions = {}) {
  const recordUploadStartedCalls: { documentId: string; s3Key: string; title: string }[] = [];
  const deleteUploadRecordCalls: string[] = [];
  const deleteUploadObjectCalls: string[] = [];
  const createUploadSlotCalls: string[] = [];

  const slot: UploadSlot = options.createUploadSlotResult ?? {
    documentId: "return-policy",
    s3Key: "raw/uploads/return-policy.pdf",
    uploadUrl: "https://s3.example.com/presigned-put-url",
    title: "Return Policy",
  };

  const built: AdminDeps = {
    sessionSecret: SECRET,
    apiKey: API_KEY,
    shopDomain: SHOP_DOMAIN,
    state: {
      async getDocumentVersion() {
        return null;
      },
      async putDocumentVersion() {},
      async listIndexedDocuments() {
        return [];
      },
      async listIndexedProducts() {
        return [];
      },
      async replaceIndexedProducts() {},
      async recordUploadStarted(input) {
        recordUploadStartedCalls.push(input);
      },
      async getUploadTitle() {
        return null;
      },
      async recordUploadReady() {},
      async recordUploadUnchanged() {},
      async recordUploadFailed() {},
      async deleteUploadRecord(documentId) {
        deleteUploadRecordCalls.push(documentId);
      },
      async listUploadedDocuments() {
        return options.documents ?? [];
      },
    },
    async createUploadSlot(purpose) {
      createUploadSlotCalls.push(purpose);
      return slot;
    },
    async deleteUploadObject(documentId) {
      deleteUploadObjectCalls.push(documentId);
    },
  };

  return {
    built,
    recordUploadStartedCalls,
    deleteUploadRecordCalls,
    deleteUploadObjectCalls,
    createUploadSlotCalls,
  };
}

function event(overrides: Partial<AdminEvent> = {}): AdminEvent {
  return {
    rawPath: "/admin/api/uploads",
    headers: { authorization: `Bearer ${validToken}` },
    requestContext: { http: { method: "GET" } },
    ...overrides,
  };
}

describe("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const { built } = deps();
    const result = await handleAdminRequest(event({ headers: {} }), built);

    expect(result.statusCode).toBe(401);
  });

  it("rejects a request with an invalid token", async () => {
    const { built } = deps();
    const result = await handleAdminRequest(
      event({ headers: { authorization: "Bearer garbage" } }),
      built,
    );

    expect(result.statusCode).toBe(401);
  });

  it("is case-insensitive about the header name", async () => {
    const { built } = deps();
    const result = await handleAdminRequest(
      event({ headers: { Authorization: `Bearer ${validToken}` } }),
      built,
    );

    expect(result.statusCode).toBe(200);
  });

  it("never reaches DynamoDB or S3 when the token is rejected", async () => {
    const { built, createUploadSlotCalls } = deps();
    await handleAdminRequest(
      event({
        headers: {},
        requestContext: { http: { method: "POST" } },
        body: JSON.stringify({ purpose: "Return Policy" }),
      }),
      built,
    );

    expect(createUploadSlotCalls).toHaveLength(0);
  });
});

describe("GET /admin/api/uploads", () => {
  it("returns the list of uploaded documents", async () => {
    const document: UploadedDocument = {
      documentId: "return-policy",
      status: "ready",
      title: "Return Policy",
      docType: "policy",
      errorMessage: null,
      s3Key: "raw/uploads/return-policy.pdf",
      uploadedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:05.000Z",
    };
    const { built } = deps({ documents: [document] });

    const result = await handleAdminRequest(event(), built);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ documents: [document] });
  });
});

describe("POST /admin/api/uploads", () => {
  const post = (body: unknown) =>
    event({
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify(body),
    });

  it("mints an upload slot and records it as started, with the slot's title", async () => {
    const { built, recordUploadStartedCalls, createUploadSlotCalls } = deps();

    const result = await handleAdminRequest(post({ purpose: "Return Policy" }), built);

    expect(result.statusCode).toBe(200);
    expect(createUploadSlotCalls).toEqual(["Return Policy"]);
    expect(recordUploadStartedCalls).toEqual([
      { documentId: "return-policy", s3Key: "raw/uploads/return-policy.pdf", title: "Return Policy" },
    ]);
    expect(JSON.parse(result.body)).toEqual({
      documentId: "return-policy",
      uploadUrl: "https://s3.example.com/presigned-put-url",
    });
  });

  it("rejects a missing purpose", async () => {
    const { built, createUploadSlotCalls } = deps();

    const result = await handleAdminRequest(post({}), built);

    expect(result.statusCode).toBe(400);
    expect(createUploadSlotCalls).toHaveLength(0);
  });

  it("rejects a blank purpose", async () => {
    const { built } = deps();

    const result = await handleAdminRequest(post({ purpose: "   " }), built);

    expect(result.statusCode).toBe(400);
  });

  it("rejects an unparseable body", async () => {
    const { built } = deps();

    const result = await handleAdminRequest(
      event({ requestContext: { http: { method: "POST" } }, body: "not json" }),
      built,
    );

    expect(result.statusCode).toBe(400);
  });

  it("decodes a base64-encoded body", async () => {
    const { built, createUploadSlotCalls } = deps();
    const body = Buffer.from(JSON.stringify({ purpose: "Return Policy" }), "utf8").toString(
      "base64",
    );

    const result = await handleAdminRequest(
      event({
        requestContext: { http: { method: "POST" } },
        body,
        isBase64Encoded: true,
      }),
      built,
    );

    expect(result.statusCode).toBe(200);
    expect(createUploadSlotCalls).toEqual(["Return Policy"]);
  });
});

describe("DELETE /admin/api/uploads/:id", () => {
  it("deletes the S3 object and the state record", async () => {
    const { built, deleteUploadObjectCalls, deleteUploadRecordCalls } = deps();

    const result = await handleAdminRequest(
      event({
        rawPath: "/admin/api/uploads/return-policy",
        requestContext: { http: { method: "DELETE" } },
      }),
      built,
    );

    expect(result.statusCode).toBe(204);
    expect(deleteUploadObjectCalls).toEqual(["return-policy"]);
    expect(deleteUploadRecordCalls).toEqual(["return-policy"]);
  });

  it("decodes a url-encoded document id", async () => {
    const { built, deleteUploadObjectCalls } = deps();

    await handleAdminRequest(
      event({
        rawPath: "/admin/api/uploads/return%20policy",
        requestContext: { http: { method: "DELETE" } },
      }),
      built,
    );

    expect(deleteUploadObjectCalls).toEqual(["return policy"]);
  });
});

describe("routing", () => {
  it("returns 404 for an unknown path", async () => {
    const { built } = deps();
    const result = await handleAdminRequest(event({ rawPath: "/admin/api/nonsense" }), built);

    expect(result.statusCode).toBe(404);
  });

  it("returns 404 for an unsupported method on a known path", async () => {
    const { built } = deps();
    const result = await handleAdminRequest(
      event({ requestContext: { http: { method: "PATCH" } } }),
      built,
    );

    expect(result.statusCode).toBe(404);
  });
});
