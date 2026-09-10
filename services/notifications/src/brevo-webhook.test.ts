import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), secretGet: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.send }) },
  GetCommand: class { constructor(readonly input: unknown) {} },
  TransactWriteCommand: class { constructor(readonly input: unknown) {} },
  UpdateCommand: class { constructor(readonly input: unknown) {} },
  PutCommand: class { constructor(readonly input: unknown) {} },
}));
vi.mock("@nailzify/adapters", () => ({
  createSecretsManagerProvider: () => ({ get: mocks.secretGet }),
}));

import { brevoDeliveryStatusForTest, handler } from "./brevo-webhook.js";
import { makeEmailReference } from "./email-reference.js";
import { makeReplyToken } from "./reply-token.js";

describe("Brevo webhook", () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({});
    mocks.secretGet.mockReset().mockImplementation(async (arn: string) =>
      arn.includes("webhook") ? "webhook-secret" : "reference-secret",
    );
    process.env["TABLE_NAME"] = "tickets";
    process.env["PROXY_SECRET_ARN"] = "reference-secret-arn";
    process.env["BREVO_WEBHOOK_SECRET_ARN"] = "webhook-secret-arn";
    process.env["BREVO_INBOUND_SPAM_SCORE_MAX"] = "5";
    process.env["MERCHANT_SUPPORT_RECIPIENTS"] = "care@nailzify.com";
  });

  it("rejects requests without the configured bearer secret", async () => {
    await expect(handler({ rawPath: "/delivery", headers: {}, body: "{}" }))
      .resolves.toEqual({ statusCode: 401, body: "Unauthorized" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("maps a delivered event to the signed ticket reference", async () => {
    const reference = makeEmailReference({
      ticketId: "TKT-1",
      eventId: "event-1",
      recipientType: "customer",
      commentId: "comment-1",
      commentCreatedAt: 100,
    }, "reference-secret");

    await handler(request("/delivery", {
      event: "delivered",
      "message-id": "brevo-message-1",
      "X-Mailin-custom": reference,
      ts_epoch: 1_800_000_000_000,
    }));

    const updates = mocks.send.mock.calls
      .map((call) => call[0] as { input: any })
      .filter((command) => command.input.UpdateExpression);
    expect(updates[0]!.input.Key.SK).toBe("OUTBOX#event-1#customer");
    expect(updates[0]!.input.ExpressionAttributeValues[":status"]).toBe("delivered");
    expect(updates[1]!.input.Key.SK).toBe("COMMENT#000000000000100#comment-1");
  });

  it.each([
    ["softBounce", "delayed"],
    ["hardBounce", "bounced"],
    ["invalidEmail", "bounced"],
    ["soft_bounce", "delayed"],
  ])("maps Brevo delivery event %s to %s", (event, status) => {
    expect(brevoDeliveryStatusForTest(event)).toBe(status);
  });

  it("accepts a clean inbound reply and reopens a solved ticket", async () => {
    const token = makeReplyToken("TKT-1", "reference-secret");
    mocks.send.mockImplementation(async (command: { input: any }) =>
      command.input.Key?.PK === "TICKET#TKT-1"
        ? { Item: inboundTicket("solved") }
        : {},
    );

    await handler(request("/inbound", { items: [{
      MessageId: "inbound-1",
      From: { Address: "customer@example.com" },
      Recipients: [`reply+${token}@tickets.nailzify.com`],
      SentAtDate: "Tue, 8 Sep 2026 12:00:00 +0000",
      ExtractedMarkdownMessage: "I still need help.",
      SpamScore: 0.2,
      Attachments: [],
    }] }));

    const transaction = mocks.send.mock.calls
      .map((call) => call[0] as { input: any })
      .find((command) => command.input.TransactItems)!;
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues[":status"]).toBe("open");
    expect(transaction.input.TransactItems[2].Put.Item.body).toBe("I still need help.");
  });

  it("rejects inbound attachments before reading a ticket", async () => {
    await handler(request("/inbound", { items: [{
      MessageId: "inbound-2",
      Attachments: [{ Name: "photo.png" }],
      SpamScore: 0,
    }] }));
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

function request(path: string, body: unknown) {
  return {
    rawPath: path,
    headers: { authorization: "Bearer webhook-secret" },
    body: JSON.stringify(body),
  };
}

function inboundTicket(status: "solved" | "closed") {
  return {
    PK: "TICKET#TKT-1",
    SK: "META",
    ticketId: "TKT-1",
    shop: "nailzify.myshopify.com",
    requesterEmail: "customer@example.com",
    requesterName: "Taylor",
    subject: "Shipping question",
    summary: "Customer asked about shipping",
    reason: "Policy unavailable",
    sessionId: "session-1",
    escalationId: "handoff-1",
    sourceChannel: "chat",
    status,
    priority: "normal",
    createdAt: 100,
    updatedAt: 100,
    version: 2,
  };
}
