import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createSecretsManagerProvider } from "@nailzify/adapters";
import { simpleParser } from "mailparser";
import { verifyReplyToken } from "./reply-token.js";

interface Verdict { readonly status?: string }
interface SesReceiptEvent {
  readonly Records?: readonly {
    readonly ses?: {
      readonly mail?: {
        readonly messageId?: string;
        readonly timestamp?: string;
        readonly destination?: readonly string[];
      };
      readonly receipt?: {
        readonly recipients?: readonly string[];
        readonly spamVerdict?: Verdict;
        readonly virusVerdict?: Verdict;
        readonly spfVerdict?: Verdict;
        readonly dkimVerdict?: Verdict;
      };
    };
  }[];
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
let cachedSecret: string | undefined;

export async function handler(event: SesReceiptEvent): Promise<void> {
  for (const record of event.Records ?? []) {
    if (record.ses) await processRecord(record.ses);
  }
}

async function processRecord(ses: NonNullable<NonNullable<SesReceiptEvent["Records"]>[number]["ses"]>): Promise<void> {
  const messageId = ses.mail?.messageId;
  if (!messageId) return reject("missing_message_id");
  const bucket = required("TICKET_EMAIL_BUCKET");
  const key = `incoming/${messageId}`;

  if (!passed(ses.receipt?.spamVerdict) || !passed(ses.receipt?.virusVerdict)) {
    await removeRaw(bucket, key);
    return reject("content_verdict_failed", messageId);
  }

  const recipient = [...(ses.receipt?.recipients ?? []), ...(ses.mail?.destination ?? [])]
    .find((value) => value.toLowerCase().startsWith("reply+"));
  const token = recipient?.match(/^reply\+([^@]+)@/i)?.[1];
  const ticketId = token ? verifyReplyToken(token, await replySecret()) : null;
  if (!ticketId) {
    await removeRaw(bucket, key);
    return reject("invalid_reply_token", messageId);
  }

  const raw = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const parsed = await simpleParser(Buffer.from(await raw.Body!.transformToByteArray()), {
    skipHtmlToText: false,
    skipTextToHtml: true,
  });
  const sender = parsed.from?.value[0]?.address?.trim().toLowerCase();
  const body = newReplyText(parsed.text ?? "");
  if (!sender || !body) {
    await removeRaw(bucket, key);
    return reject("empty_or_missing_sender", messageId, ticketId);
  }

  const table = required("TABLE_NAME");
  const result = await doc.send(new GetCommand({
    TableName: table,
    Key: { PK: `TICKET#${ticketId}`, SK: "META" },
    ConsistentRead: true,
  }));
  const ticket = result.Item;
  if (!ticket) {
    await removeRaw(bucket, key);
    return reject("ticket_not_found", messageId, ticketId);
  }
  if (sender !== String(ticket["requesterEmail"] ?? "").toLowerCase()) {
    await removeRaw(bucket, key);
    return reject("sender_mismatch", messageId, ticketId);
  }

  const receivedAt = Date.parse(ses.mail?.timestamp ?? "") || Date.now();
  try {
    if (ticket["status"] === "closed") {
      await createFollowUp(table, ticket, ticketId, messageId, body, receivedAt, await replySecret());
    } else {
      await appendReply(table, ticket, ticketId, messageId, body, receivedAt);
    }
  } catch (cause) {
    if ((cause as { name?: string }).name === "TransactionCanceledException") {
      const duplicate = await doc.send(new GetCommand({
        TableName: table,
        Key: { PK: `INBOUND#${messageId}`, SK: "META" },
        ConsistentRead: true,
      }));
      if (!duplicate.Item) throw cause;
      console.log(JSON.stringify({ event: "ticket.inbound.duplicate", ticketId, messageId }));
    } else {
      throw cause;
    }
  }
  await removeRaw(bucket, key);
  console.log(JSON.stringify({ event: "ticket.inbound.accepted", ticketId, messageId }));
}

async function appendReply(
  table: string,
  ticket: Record<string, unknown>,
  ticketId: string,
  messageId: string,
  body: string,
  at: number,
) {
  const commentId = randomUUID();
  const eventId = randomUUID();
  const previous = String(ticket["status"] ?? "open");
  const status = ["pending", "hold", "solved"].includes(previous) ? "open" : previous;
  const items: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
    dedupePut(table, messageId, ticketId, at),
    {
      Update: {
        TableName: table,
        Key: { PK: `TICKET#${ticketId}`, SK: "META" },
        UpdateExpression: "SET #status = :status, updatedAt = :at, GSI3PK = :gsiPk, GSI3SK = :gsiSk ADD #version :one",
        ConditionExpression: "#status <> :closed",
        ExpressionAttributeNames: { "#status": "status", "#version": "version" },
        ExpressionAttributeValues: {
          ":status": status,
          ":closed": "closed",
          ":at": at,
          ":one": 1,
          ":gsiPk": `SHOP#${ticket["shop"]}#STATUS#${status}`,
          ":gsiSk": `${new Date(at).toISOString()}#${ticketId}`,
        },
      },
    },
    commentPut(table, ticketId, commentId, messageId, body, at),
    eventPut(table, ticketId, eventId, previous === "solved" ? "reopened" : "public_reply_added", previous, status, at),
    ...merchantOutboxes(table, ticketId, eventId, commentId, at),
  ];
  await doc.send(new TransactWriteCommand({ TransactItems: items }));
}

async function createFollowUp(
  table: string,
  original: Record<string, unknown>,
  originalId: string,
  messageId: string,
  body: string,
  at: number,
  secret: string,
) {
  const id = `TKT-${at.toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const commentId = randomUUID();
  const eventId = randomUUID();
  const followUp = {
    ...original,
    PK: `TICKET#${id}`,
    SK: "META",
    ticketId: id,
    escalationId: `followup:${messageId}`,
    subject: `Follow up: ${String(original["subject"] ?? "Customer request")}`.slice(0, 160),
    summary: "Customer replied after the original ticket was closed.",
    addedDetail: null,
    transcript: null,
    status: "new",
    priority: original["priority"] ?? "normal",
    assigneeUserId: null,
    followUpToTicketId: originalId,
    replyTokenHash: createHmac("sha256", secret).update(`reply:${id}`).digest("hex"),
    createdAt: at,
    updatedAt: at,
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    version: 0,
    GSI3PK: `SHOP#${original["shop"]}#STATUS#new`,
    GSI3SK: `${new Date(at).toISOString()}#${id}`,
  };
  await doc.send(new TransactWriteCommand({ TransactItems: [
    dedupePut(table, messageId, id, at),
    { Put: { TableName: table, Item: followUp, ConditionExpression: "attribute_not_exists(PK)" } },
    commentPut(table, id, commentId, messageId, body, at),
    eventPut(table, id, eventId, "follow_up_created", "closed", "new", at),
    ...merchantOutboxes(table, id, eventId, commentId, at),
  ] }));
}

function dedupePut(table: string, messageId: string, ticketId: string, at: number) {
  return { Put: { TableName: table, Item: {
    PK: `INBOUND#${messageId}`, SK: "META", entityType: "InboundEmail", messageId, ticketId, createdAt: at,
  }, ConditionExpression: "attribute_not_exists(PK)" } };
}
function commentPut(table: string, ticketId: string, commentId: string, messageId: string, body: string, at: number) {
  return { Put: { TableName: table, Item: {
    PK: `TICKET#${ticketId}`,
    SK: `COMMENT#${String(at).padStart(15, "0")}#${commentId}`,
    entityType: "TicketComment", commentId, ticketId, authorType: "customer", authorId: null,
    body, visibility: "public", channel: "email", createdAt: at, inboundMessageId: messageId,
  }, ConditionExpression: "attribute_not_exists(PK)" } };
}
function eventPut(table: string, ticketId: string, eventId: string, type: string, before: string, after: string, at: number) {
  return { Put: { TableName: table, Item: {
    PK: `TICKET#${ticketId}`,
    SK: `EVENT#${String(at).padStart(15, "0")}#${eventId}`,
    entityType: "TicketEvent", eventId, ticketId, actorType: "customer", actorId: null,
    eventType: type, before: { status: before }, after: { status: after }, createdAt: at,
  }, ConditionExpression: "attribute_not_exists(PK)" } };
}
function merchantOutboxes(table: string, ticketId: string, eventId: string, commentId: string, at: number) {
  return merchantRecipients().slice(0, 1).map((recipient) => ({ Put: { TableName: table, Item: {
    PK: `TICKET#${ticketId}`, SK: `OUTBOX#${eventId}#merchant`,
    entityType: "TicketNotification", jobId: `${ticketId}:${eventId}:customer-replied:merchant`,
    ticketId, eventId, recipientType: "merchant", template: "customer-replied-merchant",
    recipient, status: "queued", attempts: 0, createdAt: at, commentId, commentCreatedAt: at,
  }, ConditionExpression: "attribute_not_exists(PK)" } }));
}

function newReplyText(text: string): string {
  return text
    .split(/\n--- Reply above this line ---/i)[0]!
    .split(/\nOn .+ wrote:\s*$/im)[0]!
    .split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0]!
    .trim()
    .slice(0, 10_000);
}
function passed(verdict: Verdict | undefined) { return verdict?.status === "PASS"; }
function merchantRecipients() {
  return required("MERCHANT_SUPPORT_RECIPIENTS").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}
async function replySecret() {
  if (cachedSecret) return cachedSecret;
  cachedSecret = await createSecretsManagerProvider({ region: process.env["AWS_REGION"] ?? "us-east-1" })
    .get(required("PROXY_SECRET_ARN"));
  return cachedSecret;
}
async function removeRaw(bucket: string, key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
function reject(reason: string, messageId?: string, ticketId?: string) {
  console.warn(JSON.stringify({ event: "ticket.inbound.rejected", reason, messageId, ticketId }));
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const inboundTextForTest = newReplyText;
