import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), secretGet: vi.fn(), fetch: vi.fn() }));
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

import {
  handler,
  resendDeliveryStatusForTest,
  resendSenderAuthenticationPassedForTest,
} from "./resend-webhook.js";
import { makeReplyToken } from "./reply-token.js";

const webhookKey = Buffer.from("resend-webhook-test-secret");
const webhookSecret = `whsec_${webhookKey.toString("base64")}`;

describe("Resend webhook", () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({});
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.secretGet.mockReset().mockImplementation(async (arn: string) =>
      arn.includes("webhook") ? webhookSecret : arn.includes("api-key") ? "resend-api-key" : "reference-secret",
    );
    process.env["TABLE_NAME"] = "tickets";
    process.env["PROXY_SECRET_ARN"] = "reference-secret-arn";
    process.env["RESEND_WEBHOOK_SECRET_ARN"] = "webhook-secret-arn";
    process.env["RESEND_API_KEY_SECRET_ARN"] = "api-key-secret-arn";
    process.env["MERCHANT_SUPPORT_RECIPIENTS"] = "care@nailzify.com";
  });

  it("rejects a request without a valid Svix signature", async () => {
    await expect(handler({ headers: {}, body: "{}" })).resolves.toEqual({
      statusCode: 401,
      body: "Invalid webhook signature",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("maps a delivered event using Resend tags", async () => {
    await handler(request({
      type: "email.delivered",
      created_at: "2026-09-08T12:00:00.000Z",
      data: {
        email_id: "resend-email-1",
        tags: {
          ticket_id: "TKT-1",
          event_id: "event-1",
          recipient_type: "customer",
          comment_id: "comment-1",
          comment_created_at: "100",
        },
      },
    }));

    const updates = mocks.send.mock.calls
      .map((call) => call[0] as { input: any })
      .filter((command) => command.input.UpdateExpression);
    expect(updates[0]!.input.Key.SK).toBe("OUTBOX#event-1#customer");
    expect(updates[0]!.input.ExpressionAttributeValues[":status"]).toBe("delivered");
    expect(updates[1]!.input.Key.SK).toBe("COMMENT#000000000000100#comment-1");
  });

  it.each([
    ["email.sent", "sent"],
    ["email.delivery_delayed", "delayed"],
    ["email.bounced", "bounced"],
    ["email.complained", "complained"],
    ["email.suppressed", "failed"],
  ])("maps Resend event %s to %s", (event, status) => {
    expect(resendDeliveryStatusForTest(event)).toBe(status);
  });

  it("accepts an authenticated inbound reply and reopens a solved ticket", async () => {
    const token = makeReplyToken("TKT-1", "reference-secret");
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      id: "received-1",
      message_id: "inbound-1",
      from: "Taylor <customer@example.com>",
      to: [`reply+${token}@tickets.nailzify.com`],
      created_at: "2026-09-08T12:00:00.000Z",
      text: "I still need help.",
      attachments: [],
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    mocks.send.mockImplementation(async (command: { input: any }) =>
      command.input.Key?.PK === "TICKET#TKT-1"
        ? { Item: inboundTicket("solved") }
        : {},
    );

    await handler(request({
      type: "email.received",
      data: { email_id: "received-1", attachments: [] },
    }));

    const transaction = mocks.send.mock.calls
      .map((call) => call[0] as { input: any })
      .find((command) => command.input.TransactItems)!;
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues[":status"]).toBe("open");
    expect(transaction.input.TransactItems[2].Put.Item.body).toBe("I still need help.");
  });

  it("rejects inbound attachments before retrieving message content", async () => {
    await handler(request({
      type: "email.received",
      data: { email_id: "received-2", attachments: [{ filename: "photo.png" }] },
    }));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires aligned sender authentication", () => {
    expect(resendSenderAuthenticationPassedForTest({ spf: "pass", dkim: "pass", dmarc: "gray" })).toBe(true);
    expect(resendSenderAuthenticationPassedForTest({ spf: "fail", dkim: "pass", dmarc: "pass" })).toBe(false);
    expect(resendSenderAuthenticationPassedForTest(null)).toBe(false);
  });
});

function request(body: unknown) {
  const payload = JSON.stringify(body);
  const id = "msg_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", webhookKey)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return {
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
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
