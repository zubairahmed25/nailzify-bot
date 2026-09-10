import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { EmailReference } from "./email-reference.js";

export type DeliveryStatus = "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

export interface DeliveryUpdate {
  readonly reference: EmailReference;
  readonly messageId: string;
  readonly status: DeliveryStatus;
  readonly at: number;
  readonly failureReason?: string;
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function recordDeliveryUpdate(update: DeliveryUpdate): Promise<void> {
  const table = required("TABLE_NAME");
  const { reference } = update;
  const failure = safeFailure(update.failureReason);
  const updateExpression = failure
    ? "SET deliveryStatus = :status, deliveryUpdatedAt = :now, outboundMessageId = :messageId, deliveryFailureReason = :reason"
    : "SET deliveryStatus = :status, deliveryUpdatedAt = :now, outboundMessageId = :messageId REMOVE deliveryFailureReason";
  const values = {
    ":status": update.status,
    ":now": update.at,
    ":messageId": update.messageId,
    ...(failure ? { ":reason": failure } : {}),
  };

  try {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: { PK: `TICKET#${reference.ticketId}`, SK: `OUTBOX#${reference.eventId}#${reference.recipientType}` },
      UpdateExpression: updateExpression,
      ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(deliveryUpdatedAt) OR deliveryUpdatedAt <= :now)",
      ExpressionAttributeValues: values,
    }));
  } catch (cause) {
    if ((cause as { name?: string }).name !== "ConditionalCheckFailedException") throw cause;
    console.warn(JSON.stringify({
      event: "ticket.email.delivery.ignored",
      ticketId: reference.ticketId,
      messageId: update.messageId,
      status: update.status,
    }));
    return;
  }

  if (reference.commentId && reference.commentCreatedAt !== undefined) {
    try {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: {
          PK: `TICKET#${reference.ticketId}`,
          SK: `COMMENT#${String(reference.commentCreatedAt).padStart(15, "0")}#${reference.commentId}`,
        },
        UpdateExpression: updateExpression,
        ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(deliveryUpdatedAt) OR deliveryUpdatedAt <= :now)",
        ExpressionAttributeValues: values,
      }));
    } catch (cause) {
      if ((cause as { name?: string }).name !== "ConditionalCheckFailedException") throw cause;
    }
  }

  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: {
        PK: `TICKET#${reference.ticketId}`,
        SK: `EVENT#${String(update.at).padStart(15, "0")}#DELIVERY#${update.messageId}#${update.status}`,
        entityType: "TicketEvent",
        eventId: `DELIVERY#${update.messageId}#${update.status}`,
        ticketId: reference.ticketId,
        actorType: "system",
        actorId: null,
        eventType: "delivery_updated",
        before: null,
        after: {
          status: update.status,
          messageId: update.messageId,
          ...(failure ? { failureReason: failure } : {}),
        },
        createdAt: update.at,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }));
  } catch (cause) {
    if ((cause as { name?: string }).name !== "ConditionalCheckFailedException") throw cause;
  }
  console.log(JSON.stringify({ event: "ticket.email.delivery", ticketId: reference.ticketId, status: update.status }));
}

function safeFailure(value: string | undefined): string | undefined {
  return value?.replace(/[\r\n]/g, " ").trim().slice(0, 300) || undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
