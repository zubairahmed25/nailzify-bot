import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.send }) },
  UpdateCommand: class { constructor(readonly input: unknown) {} },
  PutCommand: class { constructor(readonly input: unknown) {} },
}));

import { handler } from "./delivery-events.js";

describe("SES delivery events", () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({});
    process.env["TABLE_NAME"] = "tickets";
  });

  it("covers AC-5 by attaching delivered state to the same comment and outbox", async () => {
    await handler({
      time: "2026-08-23T12:00:00.000Z",
      detail: {
        eventType: "DELIVERY",
        mail: {
          messageId: "ses-message-1",
          tags: {
            ticket_id: ["TKT-1"],
            event_id: ["event-1"],
            recipient_type: ["customer"],
            comment_id: ["comment-1"],
            comment_created_at: ["100"],
          },
        },
      },
    });

    const updates = mocks.send.mock.calls.slice(0, 2).map((call) => (call[0] as { input: any }).input);
    expect(updates[0].ExpressionAttributeValues[":status"]).toBe("delivered");
    expect(updates[1].Key.SK).toBe("COMMENT#000000000000100#comment-1");
    expect(updates[1].ExpressionAttributeValues[":status"]).toBe("delivered");
  });
});
