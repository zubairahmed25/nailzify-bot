import { describe, expect, it } from "vitest";
import type { UploadedDocument } from "@nailzify/adapters";
import type { AdminDeps, UploadSlot } from "./composition-root.js";
import { handleAdminRequest, type AdminEvent } from "./handler.js";
import { signSessionTokenForTest } from "./security/verify-session-token.js";
import {
  SessionId,
  TicketEventId,
  TicketId,
  type Ticket,
  type TicketNotificationJob,
  type TicketTimeline,
} from "@nailzify/core";

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
  readonly ticket?: Ticket | null;
  readonly ticketPage?: readonly Ticket[];
  readonly timeline?: TicketTimeline;
}

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: TicketId("TKT-TEST-001"),
  shop: SHOP_DOMAIN,
  escalationId: "handoff-1",
  sessionId: SessionId("session-1"),
  requesterEmail: "customer@example.com",
  requesterEmailHash: "private-email-hash",
  requesterName: "Taylor",
  subject: "Shipping question",
  reason: "Policy unavailable",
  summary: "Customer asked whether shipping is free",
  addedDetail: null,
  transcript: null,
  sourceChannel: "chat",
  status: "new",
  priority: "normal",
  assigneeUserId: null,
  followUpToTicketId: null,
  replyTokenHash: "private-reply-token-hash",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  firstRespondedAt: null,
  solvedAt: null,
  closedAt: null,
  version: 0,
  ...overrides,
});

function deps(options: DepsOptions = {}) {
  const recordUploadStartedCalls: { documentId: string; s3Key: string; title: string }[] = [];
  const deleteUploadRecordCalls: string[] = [];
  const deleteUploadObjectCalls: string[] = [];
  const createUploadSlotCalls: string[] = [];
  const ticketListCalls: unknown[] = [];
  const ticketSaveCalls: unknown[][] = [];
  const commentCalls: unknown[][] = [];
  const retryCalls: TicketNotificationJob[] = [];

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
    tickets: {
      async create(record) { return { ticket: record.ticket, created: true }; },
      async load() { return options.ticket === undefined ? null : options.ticket; },
      async list(query) { ticketListCalls.push(query); return { items: options.ticketPage ?? [], cursor: null }; },
      async loadTimeline() { return options.timeline ?? { comments: [], events: [], notificationJobs: [] }; },
      async save(...args) { ticketSaveCalls.push(args); },
      async addComment(...args) { commentCalls.push(args); },
      async retryNotification(job) { retryCalls.push(job); },
    },
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
    ticketListCalls,
    ticketSaveCalls,
    commentCalls,
    retryCalls,
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

describe("merchant ticket workspace", () => {
  it("covers AC-3 and AC-8 by listing only the authenticated shop queue", async () => {
    const value = ticket();
    const { built, ticketListCalls } = deps({ ticketPage: [value] });

    const result = await handleAdminRequest(event({
      rawPath: "/admin/api/tickets",
      rawQueryString: "status=new,open&limit=25",
    }), built);

    expect(result.statusCode).toBe(200);
    expect(ticketListCalls).toEqual([expect.objectContaining({
      shop: SHOP_DOMAIN,
      statuses: ["new", "open"],
      limit: 25,
    })]);
    const body = JSON.parse(result.body);
    expect(body.items[0].id).toBe(value.id);
    // Security boundary: operational hashes never leave the admin API.
    expect(result.body).not.toContain("private-email-hash");
    expect(result.body).not.toContain("private-reply-token-hash");
  });

  it("covers AC-8 by hiding a ticket that belongs to another shop", async () => {
    const { built } = deps({ ticket: ticket({ shop: "another-shop.myshopify.com" }) });

    const result = await handleAdminRequest(event({
      rawPath: "/admin/api/tickets/TKT-TEST-001",
    }), built);

    expect(result.statusCode).toBe(404);
  });

  it("covers AC-4 by storing one valid lifecycle mutation with the merchant actor", async () => {
    const value = ticket();
    const { built, ticketSaveCalls } = deps({ ticket: value });

    const result = await handleAdminRequest(event({
      rawPath: `/admin/api/tickets/${value.id}`,
      requestContext: { http: { method: "PATCH" } },
      body: JSON.stringify({ expectedVersion: 0, status: "open" }),
    }), built);

    expect(result.statusCode).toBe(200);
    const [updated, audit, expectedVersion] = ticketSaveCalls[0]!;
    expect(updated).toEqual(expect.objectContaining({ status: "open", version: 1 }));
    expect(audit).toEqual(expect.objectContaining({
      actorType: "merchant",
      actorId: "merchant-user-1",
      type: "status_changed",
    }));
    expect(expectedVersion).toBe(0);
  });

  it("covers AC-5 by committing a public comment and queued email intent together", async () => {
    const value = ticket({ status: "open" });
    const { built, commentCalls } = deps({ ticket: value });

    const result = await handleAdminRequest(event({
      rawPath: `/admin/api/tickets/${value.id}/comments`,
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({
        expectedVersion: 0,
        body: "Shipping is free on orders over $25.",
        visibility: "public",
        nextStatus: "pending",
      }),
    }), built);

    expect(result.statusCode).toBe(201);
    const [updated, comment, audit, job, expectedVersion] = commentCalls[0]!;
    expect(updated).toEqual(expect.objectContaining({ status: "pending", firstRespondedAt: expect.any(Number) }));
    expect(comment).toEqual(expect.objectContaining({ visibility: "public", deliveryStatus: "queued" }));
    expect(audit).toEqual(expect.objectContaining({ type: "public_reply_added" }));
    expect(job).toEqual(expect.objectContaining({
      recipient: "customer@example.com",
      status: "queued",
      commentId: expect.any(String),
    }));
    expect(expectedVersion).toBe(0);
  });

  it("covers AC-4 by keeping a private note inside the admin boundary", async () => {
    const value = ticket({ status: "open" });
    const { built, commentCalls } = deps({ ticket: value });

    const result = await handleAdminRequest(event({
      rawPath: `/admin/api/tickets/${value.id}/comments`,
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({
        expectedVersion: 0,
        body: "Check this with the fulfilment team.",
        visibility: "private",
        nextStatus: "hold",
      }),
    }), built);

    expect(result.statusCode).toBe(201);
    const [, comment, audit, job] = commentCalls[0]!;
    expect(comment).toEqual(expect.objectContaining({ visibility: "private" }));
    expect(audit).toEqual(expect.objectContaining({ type: "private_note_added" }));
    expect(job).toBeNull();
  });

  it("covers AC-5 by requeueing the same failed logical notification", async () => {
    const value = ticket({ status: "open" });
    const failed: TicketNotificationJob = {
      id: "job-1",
      ticketId: value.id,
      eventId: TicketEventId("event-1"),
      recipientType: "customer",
      template: "merchant-public-reply",
      recipient: value.requesterEmail,
      status: "failed",
      attempts: 5,
      createdAt: value.createdAt,
    };
    const { built, retryCalls } = deps({
      ticket: value,
      timeline: { comments: [], events: [], notificationJobs: [failed] },
    });

    const result = await handleAdminRequest(event({
      rawPath: `/admin/api/tickets/${value.id}/notifications/${failed.id}/retry`,
      requestContext: { http: { method: "POST" } },
    }), built);

    expect(result.statusCode).toBe(202);
    expect(retryCalls).toEqual([failed]);
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
