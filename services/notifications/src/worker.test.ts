import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dynamoSend: vi.fn(), sesSend: vi.fn(), secretGet: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class { send = mocks.sesSend; },
  SendEmailCommand: class { constructor(readonly input: unknown) {} },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.dynamoSend }) },
  GetCommand: class { constructor(readonly input: unknown) {} },
  UpdateCommand: class { constructor(readonly input: unknown) {} },
}));
vi.mock("@nailzify/adapters", () => ({
  createSecretsManagerProvider: () => ({ get: mocks.secretGet }),
}));

import { handler } from "./worker.js";

describe("ticket email worker", () => {
  beforeEach(() => {
    mocks.dynamoSend.mockReset().mockImplementation(async (command: { input: any }) =>
      command.input.Key?.SK === "META"
        ? { Item: { subject: "Shipping question", requesterName: "Taylor" } }
        : {},
    );
    mocks.sesSend.mockReset();
    mocks.secretGet.mockReset().mockImplementation(async (arn: string) =>
      arn.includes("brevo") ? "brevo-api-key" : arn.includes("resend") ? "resend-api-key" : "reference-secret",
    );
    process.env["TABLE_NAME"] = "tickets";
    process.env["TICKET_EMAIL_PROVIDER"] = "brevo";
    process.env["BREVO_FROM_ADDRESS"] = "support@nailzify.com";
    process.env["BREVO_API_KEY_SECRET_ARN"] = "brevo-secret-arn";
    process.env["RESEND_FROM_ADDRESS"] = "support@nailzify.com";
    process.env["RESEND_API_KEY_SECRET_ARN"] = "resend-secret-arn";
    process.env["SUPPORT_REPLY_DOMAIN"] = "tickets.nailzify.com";
    process.env["PROXY_SECRET_ARN"] = "reference-secret-arn";
    process.env["ADMIN_APP_URL"] = "https://example.com/admin";
  });

  it("sends queued ticket email through Brevo and stores its message id", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ messageId: "brevo-message-1" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    await handler({ Records: [{ body: JSON.stringify({
      jobId: "job-1",
      ticketId: "TKT-1",
      eventId: "event-1",
      recipientType: "customer",
      template: "ticket-created-customer",
      recipient: "customer@example.com",
      createdAt: 100,
    }) }] });

    expect(mocks.sesSend).not.toHaveBeenCalled();
    const request = fetcher.mock.calls[0]![1]!;
    const body = JSON.parse(String(request.body));
    expect(body.replyTo.email).toMatch(/^reply\+.+@tickets\.nailzify\.com$/);
    expect(body.headers["Idempotency-Key"]).toBe("job-1");

    const sentUpdate = mocks.dynamoSend.mock.calls
      .map((call) => call[0] as { input: any })
      .find((command) => command.input.ExpressionAttributeValues?.[":messageId"] === "brevo-message-1");
    expect(sentUpdate?.input.Key.SK).toBe("OUTBOX#event-1#customer");
  });

  it("sends queued ticket email through Resend with correlation tags", async () => {
    process.env["TICKET_EMAIL_PROVIDER"] = "resend";
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ id: "resend-message-1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    await handler({ Records: [{ body: JSON.stringify({
      jobId: "job-2",
      ticketId: "TKT-2",
      eventId: "event-2",
      recipientType: "customer",
      template: "ticket-created-customer",
      recipient: "customer@example.com",
      createdAt: 100,
    }) }] });

    const request = fetcher.mock.calls[0]![1]!;
    const body = JSON.parse(String(request.body));
    expect(body.reply_to).toMatch(/^reply\+.+@tickets\.nailzify\.com$/);
    expect(body.tags).toEqual(expect.arrayContaining([
      { name: "ticket_id", value: "TKT-2" },
      { name: "event_id", value: "event-2" },
      { name: "recipient_type", value: "customer" },
    ]));

    const sentUpdate = mocks.dynamoSend.mock.calls
      .map((call) => call[0] as { input: any })
      .find((command) => command.input.ExpressionAttributeValues?.[":messageId"] === "resend-message-1");
    expect(sentUpdate?.input.Key.SK).toBe("OUTBOX#event-2#customer");
  });
});
