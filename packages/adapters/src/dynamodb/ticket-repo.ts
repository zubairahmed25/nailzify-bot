import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SessionId,
  TicketCommentId,
  TicketEventId,
  TicketId,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketNotificationJob,
  type TicketRepository,
  type TicketStatus,
} from "@nailzify/core";

export interface DynamoTicketRepoConfig {
  readonly tableName: string;
  readonly region?: string;
  readonly client?: DynamoDBDocumentClient;
}

export class ConcurrentTicketUpdate extends Error {
  readonly code = "CONCURRENT_TICKET_UPDATE";
}

const TICKET_PK = (id: string) => `TICKET#${id}`;
const META_SK = "META";
const CREATION_PK = (shop: string, escalationId: string) =>
  `TICKET_CREATE#${shop}#${escalationId}`;
const COMMENT_SK = (createdAt: number, id: string) =>
  `COMMENT#${String(createdAt).padStart(15, "0")}#${id}`;
const EVENT_SK = (createdAt: number, id: string) =>
  `EVENT#${String(createdAt).padStart(15, "0")}#${id}`;
const OUTBOX_SK = (eventId: string, recipientType: string) =>
  `OUTBOX#${eventId}#${recipientType}`;

export function createDynamoTicketRepo(config: DynamoTicketRepoConfig): TicketRepository {
  const doc =
    config.client ??
    DynamoDBDocumentClient.from(
      new DynamoDBClient(config.region ? { region: config.region } : {}),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  const table = config.tableName;

  const loadCreation = async (shop: string, escalationId: string): Promise<Ticket | null> => {
    const locator = await doc.send(new GetCommand({
      TableName: table,
      Key: { PK: CREATION_PK(shop, escalationId), SK: META_SK },
      ConsistentRead: true,
    }));
    const id = typeof locator.Item?.["ticketId"] === "string" ? locator.Item["ticketId"] : null;
    if (!id) return null;
    return loadTicket(doc, table, TicketId(id));
  };

  return {
    async create(record) {
      const existing = await loadCreation(record.ticket.shop, record.ticket.escalationId);
      if (existing) return { ticket: existing, created: false };

      const items = [
        {
          Put: {
            TableName: table,
            Item: {
              PK: CREATION_PK(record.ticket.shop, record.ticket.escalationId),
              SK: META_SK,
              entityType: "TicketCreation",
              ticketId: record.ticket.id,
              createdAt: record.ticket.createdAt,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: table,
            Item: toTicketItem(record.ticket),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: table,
            Item: toEventItem(record.createdEvent),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...record.notificationJobs.map((job) => ({
          Put: {
            TableName: table,
            Item: toNotificationItem(job),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        })),
      ];

      try {
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
        return { ticket: record.ticket, created: true };
      } catch (error) {
        if (!isTransactionConflict(error)) throw error;
        const winner = await loadCreation(record.ticket.shop, record.ticket.escalationId);
        if (!winner) throw error;
        return { ticket: winner, created: false };
      }
    },

    async load(id) {
      return loadTicket(doc, table, id);
    },

    async list(query) {
      const cursors = decodeCursor(query.cursor);
      const pages = await Promise.all(query.statuses.map(async (status) => {
        const result = await doc.send(new QueryCommand({
          TableName: table,
          IndexName: "GSI3",
          KeyConditionExpression: "GSI3PK = :pk",
          ExpressionAttributeValues: { ":pk": `SHOP#${query.shop}#STATUS#${status}` },
          ScanIndexForward: true,
          Limit: query.limit,
          ...(cursors[status] ? { ExclusiveStartKey: cursors[status] } : {}),
        }));
        return { status, result };
      }));

      const items = pages
        .flatMap(({ result }) => result.Items ?? [])
        .map(toTicket)
        .filter((ticket) => !query.priority || ticket.priority === query.priority)
        .filter((ticket) => !query.assigneeUserId || ticket.assigneeUserId === query.assigneeUserId)
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, query.limit);

      const next = Object.fromEntries(
        pages
          .filter(({ result }) => result.LastEvaluatedKey)
          .map(({ status, result }) => [status, result.LastEvaluatedKey!]),
      );

      return {
        items,
        cursor: Object.keys(next).length > 0 ? encodeCursor(next) : null,
      };
    },

    async loadTimeline(id) {
      const result = await doc.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": TICKET_PK(id) },
        ConsistentRead: true,
      }));
      const items = result.Items ?? [];
      return {
        comments: items.filter((item) => item["entityType"] === "TicketComment").map(toComment),
        events: items.filter((item) => item["entityType"] === "TicketEvent").map(toEvent),
        notificationJobs: items
          .filter((item) => item["entityType"] === "TicketNotification")
          .map(toNotification),
      };
    },

    async save(ticket, event, expectedVersion) {
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            ticketPut(table, ticket, expectedVersion),
            eventPut(table, event),
          ],
        }));
      } catch (error) {
        if (isTransactionConflict(error)) {
          throw new ConcurrentTicketUpdate(
            `Ticket ${ticket.id} changed since version ${expectedVersion}`,
          );
        }
        throw error;
      }
    },

    async addComment(ticket, comment, event, job, expectedVersion) {
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            ticketPut(table, ticket, expectedVersion),
            {
              Put: {
                TableName: table,
                Item: toCommentItem(comment),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            eventPut(table, event),
            ...(job
              ? [{
                  Put: {
                    TableName: table,
                    Item: toNotificationItem(job),
                    ConditionExpression: "attribute_not_exists(PK)",
                  },
                }]
              : []),
          ],
        }));
      } catch (error) {
        if (isTransactionConflict(error)) {
          throw new ConcurrentTicketUpdate(
            `Ticket ${ticket.id} changed since version ${expectedVersion}`,
          );
        }
        throw error;
      }
    },

    async retryNotification(job) {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: {
          PK: TICKET_PK(job.ticketId),
          SK: OUTBOX_SK(job.eventId, job.recipientType),
        },
        UpdateExpression: "SET #status = :queued, queuedAt = :now REMOVE failureReason, failedAt",
        ConditionExpression: "#status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":queued": "queued", ":failed": "failed", ":now": Date.now() },
      }));
    },
  };
}

function ticketPut(table: string, ticket: Ticket, expectedVersion: number) {
  return {
    Put: {
      TableName: table,
      Item: toTicketItem(ticket),
      ConditionExpression: "#version = :expected",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":expected": expectedVersion },
    },
  };
}

function eventPut(table: string, event: TicketEvent) {
  return {
    Put: {
      TableName: table,
      Item: toEventItem(event),
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

async function loadTicket(
  doc: DynamoDBDocumentClient,
  table: string,
  id: TicketId,
): Promise<Ticket | null> {
  const result = await doc.send(new GetCommand({
    TableName: table,
    Key: { PK: TICKET_PK(id), SK: META_SK },
    ConsistentRead: true,
  }));
  return result.Item ? toTicket(result.Item) : null;
}

function toTicketItem(ticket: Ticket): Record<string, unknown> {
  return {
    PK: TICKET_PK(ticket.id),
    SK: META_SK,
    entityType: "Ticket",
    ticketId: ticket.id,
    shop: ticket.shop,
    escalationId: ticket.escalationId,
    sessionId: ticket.sessionId,
    requesterEmail: ticket.requesterEmail,
    requesterEmailHash: ticket.requesterEmailHash,
    requesterName: ticket.requesterName,
    subject: ticket.subject,
    reason: ticket.reason,
    summary: ticket.summary,
    addedDetail: ticket.addedDetail,
    transcript: ticket.transcript,
    sourceChannel: ticket.sourceChannel,
    status: ticket.status,
    priority: ticket.priority,
    assigneeUserId: ticket.assigneeUserId,
    followUpToTicketId: ticket.followUpToTicketId,
    replyTokenHash: ticket.replyTokenHash,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    firstRespondedAt: ticket.firstRespondedAt,
    solvedAt: ticket.solvedAt,
    closedAt: ticket.closedAt,
    version: ticket.version,
    GSI3PK: `SHOP#${ticket.shop}#STATUS#${ticket.status}`,
    GSI3SK: `${new Date(ticket.updatedAt).toISOString()}#${ticket.id}`,
  };
}

function toCommentItem(comment: TicketComment): Record<string, unknown> {
  return {
    PK: TICKET_PK(comment.ticketId),
    SK: COMMENT_SK(comment.createdAt, comment.id),
    entityType: "TicketComment",
    commentId: comment.id,
    ticketId: comment.ticketId,
    authorType: comment.authorType,
    authorId: comment.authorId,
    body: comment.body,
    visibility: comment.visibility,
    channel: comment.channel,
    createdAt: comment.createdAt,
    inboundMessageId: comment.inboundMessageId,
    outboundMessageId: comment.outboundMessageId,
    deliveryStatus: comment.deliveryStatus,
    deliveryUpdatedAt: comment.deliveryUpdatedAt,
    deliveryFailureReason: comment.deliveryFailureReason,
  };
}

function toEventItem(event: TicketEvent): Record<string, unknown> {
  return {
    PK: TICKET_PK(event.ticketId),
    SK: EVENT_SK(event.createdAt, event.id),
    entityType: "TicketEvent",
    eventId: event.id,
    ticketId: event.ticketId,
    actorType: event.actorType,
    actorId: event.actorId,
    eventType: event.type,
    before: event.before,
    after: event.after,
    createdAt: event.createdAt,
  };
}

function toNotificationItem(job: TicketNotificationJob): Record<string, unknown> {
  return {
    PK: TICKET_PK(job.ticketId),
    SK: OUTBOX_SK(job.eventId, job.recipientType),
    entityType: "TicketNotification",
    jobId: job.id,
    ticketId: job.ticketId,
    eventId: job.eventId,
    recipientType: job.recipientType,
    template: job.template,
    recipient: job.recipient,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    commentId: job.commentId,
    commentCreatedAt: job.commentCreatedAt,
    deliveryStatus: job.deliveryStatus,
    deliveryUpdatedAt: job.deliveryUpdatedAt,
    outboundMessageId: job.outboundMessageId,
    failureReason: job.failureReason,
  };
}

function toTicket(item: Record<string, unknown>): Ticket {
  const status = requiredString(item, "status");
  const priority = requiredString(item, "priority");
  if (!TICKET_STATUSES.includes(status as TicketStatus)) throw new Error(`Invalid ticket status ${status}`);
  if (!TICKET_PRIORITIES.includes(priority as Ticket["priority"])) throw new Error(`Invalid ticket priority ${priority}`);
  return {
    id: TicketId(requiredString(item, "ticketId")),
    shop: requiredString(item, "shop"),
    escalationId: requiredString(item, "escalationId"),
    sessionId: SessionId(requiredString(item, "sessionId")),
    requesterEmail: requiredString(item, "requesterEmail"),
    requesterEmailHash: requiredString(item, "requesterEmailHash"),
    requesterName: nullableString(item["requesterName"]),
    subject: requiredString(item, "subject"),
    reason: requiredString(item, "reason"),
    summary: requiredString(item, "summary"),
    addedDetail: nullableString(item["addedDetail"]),
    transcript: Array.isArray(item["transcript"])
      ? item["transcript"] as Ticket["transcript"]
      : null,
    sourceChannel: "chat",
    status: status as TicketStatus,
    priority: priority as Ticket["priority"],
    assigneeUserId: nullableString(item["assigneeUserId"]),
    followUpToTicketId: typeof item["followUpToTicketId"] === "string"
      ? TicketId(item["followUpToTicketId"])
      : null,
    replyTokenHash: requiredString(item, "replyTokenHash"),
    createdAt: number(item, "createdAt"),
    ...(typeof item["commentId"] === "string" ? { commentId: TicketCommentId(item["commentId"]) } : {}),
    ...(typeof item["commentCreatedAt"] === "number" ? { commentCreatedAt: item["commentCreatedAt"] } : {}),
    ...(typeof item["deliveryStatus"] === "string" ? { deliveryStatus: item["deliveryStatus"] as NonNullable<TicketNotificationJob["deliveryStatus"]> } : {}),
    ...(typeof item["deliveryUpdatedAt"] === "number" ? { deliveryUpdatedAt: item["deliveryUpdatedAt"] } : {}),
    ...(typeof item["outboundMessageId"] === "string" ? { outboundMessageId: item["outboundMessageId"] } : {}),
    ...(typeof item["failureReason"] === "string" ? { failureReason: item["failureReason"] } : {}),
    updatedAt: number(item, "updatedAt"),
    firstRespondedAt: nullableNumber(item["firstRespondedAt"]),
    solvedAt: nullableNumber(item["solvedAt"]),
    closedAt: nullableNumber(item["closedAt"]),
    version: number(item, "version"),
  };
}

function toComment(item: Record<string, unknown>): TicketComment {
  return {
    id: TicketCommentId(requiredString(item, "commentId")),
    ticketId: TicketId(requiredString(item, "ticketId")),
    authorType: requiredString(item, "authorType") as TicketComment["authorType"],
    authorId: nullableString(item["authorId"]),
    body: requiredString(item, "body"),
    visibility: requiredString(item, "visibility") as TicketComment["visibility"],
    channel: requiredString(item, "channel") as TicketComment["channel"],
    createdAt: number(item, "createdAt"),
    ...(typeof item["inboundMessageId"] === "string" ? { inboundMessageId: item["inboundMessageId"] } : {}),
    ...(typeof item["outboundMessageId"] === "string" ? { outboundMessageId: item["outboundMessageId"] } : {}),
    ...(typeof item["deliveryStatus"] === "string" ? { deliveryStatus: item["deliveryStatus"] as NonNullable<TicketComment["deliveryStatus"]> } : {}),
    ...(typeof item["deliveryUpdatedAt"] === "number" ? { deliveryUpdatedAt: item["deliveryUpdatedAt"] } : {}),
    ...(typeof item["deliveryFailureReason"] === "string" ? { deliveryFailureReason: item["deliveryFailureReason"] } : {}),
  };
}

function toEvent(item: Record<string, unknown>): TicketEvent {
  return {
    id: TicketEventId(requiredString(item, "eventId")),
    ticketId: TicketId(requiredString(item, "ticketId")),
    actorType: requiredString(item, "actorType") as TicketEvent["actorType"],
    actorId: nullableString(item["actorId"]),
    type: requiredString(item, "eventType") as TicketEvent["type"],
    before: isRecord(item["before"]) ? item["before"] : null,
    after: isRecord(item["after"]) ? item["after"] : null,
    createdAt: number(item, "createdAt"),
  };
}

function toNotification(item: Record<string, unknown>): TicketNotificationJob {
  return {
    id: requiredString(item, "jobId"),
    ticketId: TicketId(requiredString(item, "ticketId")),
    eventId: TicketEventId(requiredString(item, "eventId")),
    recipientType: requiredString(item, "recipientType") as TicketNotificationJob["recipientType"],
    template: requiredString(item, "template"),
    recipient: requiredString(item, "recipient"),
    status: requiredString(item, "status") as TicketNotificationJob["status"],
    attempts: number(item, "attempts"),
    createdAt: number(item, "createdAt"),
  };
}

function requiredString(item: Record<string, unknown>, key: string): string {
  if (typeof item[key] !== "string" || item[key] === "") throw new Error(`Ticket item is missing ${key}`);
  return item[key];
}
const number = (item: Record<string, unknown>, key: string): number =>
  typeof item[key] === "number" ? item[key] : 0;
const nullableString = (value: unknown): string | null => typeof value === "string" ? value : null;
const nullableNumber = (value: unknown): number | null => typeof value === "number" ? value : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type CursorMap = Partial<Record<TicketStatus, Record<string, unknown>>>;
function encodeCursor(value: CursorMap): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value: string | undefined): CursorMap {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed as CursorMap : {};
  } catch {
    return {};
  }
}

function isTransactionConflict(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === "TransactionCanceledException" || name === "ConditionalCheckFailedException";
}
