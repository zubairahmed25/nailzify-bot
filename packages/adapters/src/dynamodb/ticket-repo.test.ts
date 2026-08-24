import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  SessionId,
  TicketEventId,
  TicketId,
  type Ticket,
  type TicketEvent,
  type TicketNotificationJob,
} from "@nailzify/core";
import { describe, expect, it, vi } from "vitest";
import { ConcurrentTicketUpdate, createDynamoTicketRepo } from "./ticket-repo.js";

const TABLE = "nailzify-test";
const NOW = 1_700_000_000_000;

function fakeClient(handler?: (name: string, input: Record<string, any>) => unknown) {
  const sent: { name: string; input: Record<string, any> }[] = [];
  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    const name = command.constructor.name;
    const input = command.input as Record<string, any>;
    sent.push({ name, input });
    return handler?.(name, input) ?? {};
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, sent };
}

const ticket = (id = "01JTEST"): Ticket => ({
  id: TicketId(id),
  shop: "nailzify.myshopify.com",
  escalationId: "esc-1",
  sessionId: SessionId("session-1"),
  requesterEmail: "customer@example.com",
  requesterEmailHash: "email-hash",
  requesterName: "Taylor",
  subject: "Shipping question",
  reason: "missing_policy",
  summary: "Customer needs shipping help",
  addedDetail: null,
  transcript: null,
  sourceChannel: "chat",
  status: "new",
  priority: "normal",
  assigneeUserId: null,
  followUpToTicketId: null,
  replyTokenHash: "reply-hash",
  createdAt: NOW,
  updatedAt: NOW,
  firstRespondedAt: null,
  solvedAt: null,
  closedAt: null,
  version: 0,
});

const event = (value = ticket()): TicketEvent => ({
  id: TicketEventId("event-1"),
  ticketId: value.id,
  actorType: "customer",
  actorId: null,
  type: "created",
  before: null,
  after: { status: "new" },
  createdAt: NOW,
});

const job = (value = ticket()): TicketNotificationJob => ({
  id: "job-1",
  ticketId: value.id,
  eventId: TicketEventId("event-1"),
  recipientType: "customer",
  template: "ticket-created-customer",
  recipient: value.requesterEmail,
  status: "queued",
  attempts: 0,
  createdAt: NOW,
});

describe("idempotent ticket creation", () => {
  it("writes locator, ticket, audit event, and outbox atomically", async () => {
    const fake = fakeClient();
    const repo = createDynamoTicketRepo({ tableName: TABLE, client: fake.client });
    const value = ticket();

    const result = await repo.create({ ticket: value, createdEvent: event(value), notificationJobs: [job(value)] });

    expect(result.created).toBe(true);
    const transaction = fake.sent.find((item) => item.name === "TransactWriteCommand")!;
    expect(transaction.input["TransactItems"]).toHaveLength(4);
    expect(transaction.input["TransactItems"][0].Put.Item.PK).toContain("TICKET_CREATE#");
    expect(transaction.input["TransactItems"][1].Put.Item.GSI3PK).toBe(
      "SHOP#nailzify.myshopify.com#STATUS#new",
    );
  });

  it("returns the original ticket when the same escalation is retried", async () => {
    const existing = ticket("01JORIGINAL");
    const fake = fakeClient((name, input) => {
      if (name !== "GetCommand") return {};
      if (input["Key"].PK.startsWith("TICKET_CREATE#")) return { Item: { ticketId: existing.id } };
      return { Item: ticketItem(existing) };
    });
    const repo = createDynamoTicketRepo({ tableName: TABLE, client: fake.client });

    const result = await repo.create({ ticket: ticket("01JRETRY"), createdEvent: event(), notificationJobs: [] });

    expect(result.created).toBe(false);
    expect(result.ticket.id).toBe(existing.id);
    expect(fake.sent.some((item) => item.name === "TransactWriteCommand")).toBe(false);
  });
});

describe("ticket queue", () => {
  it("queries GSI3 without putting contact data in an index key", async () => {
    const fake = fakeClient((name) => name === "QueryCommand" ? { Items: [ticketItem(ticket())] } : {});
    const repo = createDynamoTicketRepo({ tableName: TABLE, client: fake.client });

    const page = await repo.list({ shop: "nailzify.myshopify.com", statuses: ["new"], limit: 25 });

    const query = fake.sent.find((item) => item.name === "QueryCommand")!.input;
    expect(query["IndexName"]).toBe("GSI3");
    expect(query["ExpressionAttributeValues"][":pk"]).toBe(
      "SHOP#nailzify.myshopify.com#STATUS#new",
    );
    expect(page.items[0]!.requesterEmail).toBe("customer@example.com");
  });
});

describe("optimistic updates", () => {
  it("conditions ticket mutation on the prior version", async () => {
    const fake = fakeClient();
    const repo = createDynamoTicketRepo({ tableName: TABLE, client: fake.client });
    const updated = { ...ticket(), status: "open" as const, version: 1 };

    await repo.save(updated, { ...event(updated), type: "status_changed" }, 0);

    const transaction = fake.sent.find((item) => item.name === "TransactWriteCommand")!;
    const put = transaction.input["TransactItems"][0].Put;
    expect(put.ConditionExpression).toContain("#version = :expected");
    expect(put.ExpressionAttributeValues[":expected"]).toBe(0);
  });

  it("turns a lost race into a named concurrency error", async () => {
    const fake = fakeClient((name) => {
      if (name === "TransactWriteCommand") {
        throw Object.assign(new Error("race"), { name: "TransactionCanceledException" });
      }
      return {};
    });
    const repo = createDynamoTicketRepo({ tableName: TABLE, client: fake.client });

    await expect(repo.save(ticket(), event(), 0)).rejects.toBeInstanceOf(ConcurrentTicketUpdate);
  });
});

function ticketItem(value: Ticket): Record<string, unknown> {
  return {
    ticketId: value.id,
    shop: value.shop,
    escalationId: value.escalationId,
    sessionId: value.sessionId,
    requesterEmail: value.requesterEmail,
    requesterEmailHash: value.requesterEmailHash,
    requesterName: value.requesterName,
    subject: value.subject,
    reason: value.reason,
    summary: value.summary,
    addedDetail: value.addedDetail,
    transcript: value.transcript,
    sourceChannel: value.sourceChannel,
    status: value.status,
    priority: value.priority,
    assigneeUserId: value.assigneeUserId,
    followUpToTicketId: value.followUpToTicketId,
    replyTokenHash: value.replyTokenHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    firstRespondedAt: value.firstRespondedAt,
    solvedAt: value.solvedAt,
    closedAt: value.closedAt,
    version: value.version,
  };
}
