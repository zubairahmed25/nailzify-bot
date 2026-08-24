import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ s3Send: vi.fn(), dynamoSend: vi.fn(), simpleParser: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.dynamoSend }) },
  GetCommand: class { constructor(readonly input: unknown) {} },
  TransactWriteCommand: class { constructor(readonly input: unknown) {} },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mocks.s3Send; },
  DeleteObjectCommand: class { constructor(readonly input: unknown) {} },
  GetObjectCommand: class { constructor(readonly input: unknown) {} },
}));
vi.mock("@nailzify/adapters", () => ({
  createSecretsManagerProvider: () => ({ get: async () => "secret" }),
}));
vi.mock("mailparser", () => ({ simpleParser: mocks.simpleParser }));

import { handler } from "./inbound.js";
import { makeReplyToken } from "./reply-token.js";

describe("inbound email security gate", () => {
  beforeEach(() => {
    mocks.s3Send.mockReset().mockResolvedValue({});
    mocks.dynamoSend.mockReset().mockResolvedValue({});
    mocks.simpleParser.mockReset();
    process.env["TICKET_EMAIL_BUCKET"] = "raw-email";
    process.env["TABLE_NAME"] = "tickets";
    process.env["PROXY_SECRET_ARN"] = "secret-arn";
    process.env["MERCHANT_SUPPORT_RECIPIENTS"] = "care@nailzify.com";
  });

  it("covers AC-6 by reopening a solved ticket with one inbound public comment", async () => {
    const token = makeReplyToken("TKT-1", "secret");
    mocks.s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) =>
      "Key" in command.input && String(command.input.Key).startsWith("incoming/")
        ? { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
        : {},
    );
    mocks.simpleParser.mockResolvedValue({
      from: { value: [{ address: "customer@example.com" }] },
      text: "I still need help.\n\n--- Reply above this line ---\nOld content",
    });
    mocks.dynamoSend.mockImplementation(async (command: { input: any }) =>
      command.input.Key?.PK === "TICKET#TKT-1"
        ? { Item: inboundTicket("solved") }
        : {},
    );

    await handler(validEvent("message-solved", token));

    const transaction = mocks.dynamoSend.mock.calls
      .map((call) => call[0] as { input: any })
      .find((command) => command.input.TransactItems)!;
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues[":status"]).toBe("open");
    expect(transaction.input.TransactItems[2].Put.Item).toEqual(expect.objectContaining({
      body: "I still need help.",
      visibility: "public",
      channel: "email",
    }));
    expect(transaction.input.TransactItems[3].Put.Item.eventType).toBe("reopened");
  });

  it("covers AC-6 by creating a linked follow up instead of mutating a closed ticket", async () => {
    const token = makeReplyToken("TKT-1", "secret");
    mocks.s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) =>
      "Key" in command.input && String(command.input.Key).startsWith("incoming/")
        ? { Body: { transformToByteArray: async () => new Uint8Array([1]) } }
        : {},
    );
    mocks.simpleParser.mockResolvedValue({
      from: { value: [{ address: "customer@example.com" }] },
      text: "One more question.",
    });
    mocks.dynamoSend.mockImplementation(async (command: { input: any }) =>
      command.input.Key?.PK === "TICKET#TKT-1"
        ? { Item: inboundTicket("closed") }
        : {},
    );

    await handler(validEvent("message-closed", token));

    const transaction = mocks.dynamoSend.mock.calls
      .map((call) => call[0] as { input: any })
      .find((command) => command.input.TransactItems)!;
    const followUp = transaction.input.TransactItems[1].Put.Item;
    expect(followUp).toEqual(expect.objectContaining({
      status: "new",
      followUpToTicketId: "TKT-1",
      requesterEmail: "customer@example.com",
    }));
    expect(followUp.ticketId).not.toBe("TKT-1");
  });

  it("covers AC-7 by deleting failed malware scans before any ticket read or comment write", async () => {
    await handler({ Records: [{ ses: {
      mail: { messageId: "message-1", destination: ["reply+bad@support.nailzify.com"] },
      receipt: {
        recipients: ["reply+bad@support.nailzify.com"],
        spamVerdict: { status: "PASS" },
        virusVerdict: { status: "FAIL" },
      },
    } }] });

    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    expect(mocks.dynamoSend).not.toHaveBeenCalled();
  });

  it("covers AC-7 by rejecting an invalid reply token before loading email content", async () => {
    await handler({ Records: [{ ses: {
      mail: { messageId: "message-2", destination: ["reply+tampered@support.nailzify.com"] },
      receipt: {
        recipients: ["reply+tampered@support.nailzify.com"],
        spamVerdict: { status: "PASS" },
        virusVerdict: { status: "PASS" },
      },
    } }] });

    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    expect(mocks.dynamoSend).not.toHaveBeenCalled();
  });
});

function validEvent(messageId: string, token: string) {
  const recipient = `reply+${token}@support.nailzify.com`;
  return { Records: [{ ses: {
    mail: { messageId, timestamp: "2026-08-23T12:00:00.000Z", destination: [recipient] },
    receipt: {
      recipients: [recipient],
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
    },
  } }] };
}

function inboundTicket(status: "solved" | "closed") {
  return {
    PK: "TICKET#TKT-1",
    SK: "META",
    entityType: "Ticket",
    ticketId: "TKT-1",
    shop: "nailzify.myshopify.com",
    requesterEmail: "customer@example.com",
    requesterEmailHash: "hash",
    requesterName: "Taylor",
    subject: "Shipping question",
    summary: "Customer asked about shipping",
    reason: "Policy unavailable",
    sessionId: "session-1",
    escalationId: "handoff-1",
    sourceChannel: "chat",
    status,
    priority: "normal",
    replyTokenHash: "hash",
    createdAt: 100,
    updatedAt: 100,
    version: 2,
    solvedAt: status === "solved" ? 100 : null,
    closedAt: status === "closed" ? 100 : null,
  };
}
