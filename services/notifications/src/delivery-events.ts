import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

interface SesEvent {
  readonly time?: string;
  readonly detail?: {
    readonly eventType?: string;
    readonly mail?: {
      readonly messageId?: string;
      readonly tags?: Record<string, readonly string[]>;
    };
  };
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function handler(event: SesEvent): Promise<void> {
  const type = event.detail?.eventType?.toUpperCase() ?? "";
  const status = statusFor(type);
  if (!status) return;
  const tags = event.detail?.mail?.tags ?? {};
  const ticketId = first(tags, "ticket_id");
  const commentId = first(tags, "comment_id");
  const createdAt = Number(first(tags, "comment_created_at"));
  const eventId = first(tags, "event_id");
  const recipientType = first(tags, "recipient_type");
  const messageId = event.detail?.mail?.messageId ?? "unknown";
  if (!ticketId) return;
  const table = required("TABLE_NAME");
  const eventTime = event.time ? Date.parse(event.time) : Number.NaN;
  const now = Number.isFinite(eventTime) ? eventTime : Date.now();

  if (eventId && recipientType) {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: { PK: `TICKET#${ticketId}`, SK: `OUTBOX#${eventId}#${recipientType}` },
      UpdateExpression: "SET deliveryStatus = :status, deliveryUpdatedAt = :now",
      ExpressionAttributeValues: { ":status": status, ":now": now },
    }));
  }
  if (commentId && Number.isFinite(createdAt)) {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: {
        PK: `TICKET#${ticketId}`,
        SK: `COMMENT#${String(createdAt).padStart(15, "0")}#${commentId}`,
      },
      UpdateExpression: "SET deliveryStatus = :status, deliveryUpdatedAt = :now",
      ExpressionAttributeValues: { ":status": status, ":now": now },
    }));
  }

  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: {
        PK: `TICKET#${ticketId}`,
        SK: `EVENT#${String(now).padStart(15, "0")}#DELIVERY#${messageId}#${status}`,
        entityType: "TicketEvent",
        eventId: `DELIVERY#${messageId}#${status}`,
        ticketId,
        actorType: "system",
        actorId: null,
        eventType: "delivery_updated",
        before: null,
        after: { status, messageId },
        createdAt: now,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }));
  } catch (cause) {
    if ((cause as { name?: string }).name !== "ConditionalCheckFailedException") throw cause;
  }
  console.log(JSON.stringify({ event: "ticket.email.delivery", ticketId, status }));
}

function statusFor(type: string) {
  return ({
    SEND: "sent",
    DELIVERY: "delivered",
    DELIVERYDELAY: "delayed",
    BOUNCE: "bounced",
    COMPLAINT: "complained",
    REJECT: "failed",
    RENDERINGFAILURE: "failed",
  } as Record<string, string>)[type.replaceAll("_", "")] ?? null;
}
const first = (tags: Record<string, readonly string[]>, name: string) => tags[name]?.[0];
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
