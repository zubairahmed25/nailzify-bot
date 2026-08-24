import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(): Promise<void> {
  const table = required("TABLE_NAME");
  const shop = required("SHOP_DOMAIN");
  const days = Math.max(Number(process.env["TICKET_CLOSE_AFTER_DAYS"] ?? 7), 1);
  const now = Date.now();
  const cutoff = now - days * 86_400_000;
  let startKey: Record<string, unknown> | undefined;
  let closed = 0;

  do {
    const result = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :pk",
      ExpressionAttributeValues: { ":pk": `SHOP#${shop}#STATUS#solved` },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const ticket of result.Items ?? []) {
      const solvedAt = typeof ticket["solvedAt"] === "number" ? ticket["solvedAt"] : Number.POSITIVE_INFINITY;
      if (solvedAt > cutoff || typeof ticket["ticketId"] !== "string") continue;
      const ticketId = ticket["ticketId"];
      const eventId = randomUUID();
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: [
          {
            Update: {
              TableName: table,
              Key: { PK: `TICKET#${ticketId}`, SK: "META" },
              UpdateExpression: "SET #status = :closed, closedAt = :now, updatedAt = :now, GSI3PK = :gsiPk, GSI3SK = :gsiSk ADD #version :one",
              ConditionExpression: "#status = :solved AND solvedAt <= :cutoff",
              ExpressionAttributeNames: { "#status": "status", "#version": "version" },
              ExpressionAttributeValues: {
                ":closed": "closed", ":solved": "solved", ":now": now, ":cutoff": cutoff, ":one": 1,
                ":gsiPk": `SHOP#${shop}#STATUS#closed`,
                ":gsiSk": `${new Date(now).toISOString()}#${ticketId}`,
              },
            },
          },
          {
            Put: {
              TableName: table,
              Item: {
                PK: `TICKET#${ticketId}`,
                SK: `EVENT#${String(now).padStart(15, "0")}#${eventId}`,
                entityType: "TicketEvent", eventId, ticketId, actorType: "system", actorId: null,
                eventType: "status_changed", before: { status: "solved" }, after: { status: "closed" }, createdAt: now,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ] }));
        closed += 1;
      } catch (cause) {
        if ((cause as { name?: string }).name !== "TransactionCanceledException") throw cause;
      }
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  console.log(JSON.stringify({ event: "ticket.solved.closed", count: closed, closeAfterDays: days }));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
