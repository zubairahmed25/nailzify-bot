import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = mocks.send; },
  SendMessageBatchCommand: class { constructor(readonly input: unknown) {} },
}));

import { handler } from "./dispatcher.js";

const image = (status: string) => ({
  entityType: { S: "TicketNotification" },
  jobId: { S: "job-1" },
  ticketId: { S: "TKT-1" },
  eventId: { S: "event-1" },
  recipientType: { S: "customer" },
  template: { S: "ticket-created-customer" },
  recipient: { S: "customer@example.com" },
  status: { S: status },
  createdAt: { N: "100" },
});

describe("ticket outbox dispatch", () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({});
    process.env["TICKET_NOTIFICATION_QUEUE_URL"] = "https://sqs.example.test/queue";
  });

  it("covers AC-9 by queuing new outbox records and explicit retries", async () => {
    await handler({ Records: [
      { eventName: "INSERT", dynamodb: { NewImage: image("queued") } },
      { eventName: "MODIFY", dynamodb: { OldImage: image("failed"), NewImage: image("queued") } },
      { eventName: "MODIFY", dynamodb: { OldImage: image("processing"), NewImage: image("sent") } },
    ] });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const command = mocks.send.mock.calls[0]![0] as { input: { Entries: unknown[] } };
    expect(command.input.Entries).toHaveLength(2);
  });
});
