import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createSecretsManagerProvider } from "@nailzify/adapters";
import { sendBrevoEmail } from "./brevo-client.js";
import { makeEmailReference } from "./email-reference.js";
import { makeReplyToken } from "./reply-token.js";
import { sendResendEmail } from "./resend-client.js";

interface QueueRecord { readonly body: string }
interface QueueEvent { readonly Records: readonly QueueRecord[] }
interface Job {
  readonly jobId: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly recipientType: "customer" | "merchant";
  readonly template: string;
  readonly recipient: string;
  readonly createdAt: number;
  readonly commentId?: string;
  readonly commentCreatedAt?: number;
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ses = new SESv2Client({});
let cachedReplySecret: string | undefined;
let cachedBrevoApiKey: string | undefined;
let cachedResendApiKey: string | undefined;

export async function handler(event: QueueEvent): Promise<void> {
  for (const record of event.Records) await deliver(JSON.parse(record.body) as Job);
}

async function deliver(job: Job): Promise<void> {
  const table = required("TABLE_NAME");
  const outboxKey = { PK: `TICKET#${job.ticketId}`, SK: `OUTBOX#${job.eventId}#${job.recipientType}` };
  try {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: outboxKey,
      UpdateExpression: "SET #status = :processing, processingAt = :now ADD attempts :one",
      ConditionExpression: "attribute_not_exists(#status) OR #status <> :sent",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": "processing", ":sent": "sent", ":now": Date.now(), ":one": 1 },
    }));
  } catch (cause) {
    if ((cause as { name?: string }).name === "ConditionalCheckFailedException") return;
    throw cause;
  }

  const ticketResult = await doc.send(new GetCommand({
    TableName: table,
    Key: { PK: `TICKET#${job.ticketId}`, SK: "META" },
    ConsistentRead: true,
  }));
  const ticket = ticketResult.Item;
  if (!ticket) throw new Error(`Ticket ${job.ticketId} not found`);

  let publicReply = "";
  if (job.commentId && job.commentCreatedAt !== undefined) {
    const commentResult = await doc.send(new GetCommand({
      TableName: table,
      Key: {
        PK: `TICKET#${job.ticketId}`,
        SK: `COMMENT#${String(job.commentCreatedAt).padStart(15, "0")}#${job.commentId}`,
      },
      ConsistentRead: true,
    }));
    publicReply = string(commentResult.Item?.["body"]);
  }
  const email = render(job, ticket, publicReply);
  try {
    const secret = await replySecret();
    const replyTo = job.recipientType === "customer"
      ? `reply+${makeReplyToken(job.ticketId, secret)}@${required("SUPPORT_REPLY_DOMAIN")}`
      : undefined;
    const messageId = await sendEmail(job, email, replyTo, secret);

    await doc.send(new UpdateCommand({
      TableName: table,
      Key: outboxKey,
      UpdateExpression: "SET #status = :sent, sentAt = :now, outboundMessageId = :messageId REMOVE failureReason",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":sent": "sent", ":now": Date.now(), ":messageId": messageId },
    }));
    if (job.commentId && job.commentCreatedAt !== undefined) {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: {
          PK: `TICKET#${job.ticketId}`,
          SK: `COMMENT#${String(job.commentCreatedAt).padStart(15, "0")}#${job.commentId}`,
        },
        UpdateExpression: "SET deliveryStatus = :sent, deliveryUpdatedAt = :now, outboundMessageId = :messageId",
        ExpressionAttributeValues: { ":sent": "sent", ":now": Date.now(), ":messageId": messageId },
      }));
    }
    console.log(JSON.stringify({ event: "ticket.email.sent", ticketId: job.ticketId, jobId: job.jobId }));
  } catch (cause) {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: outboxKey,
      UpdateExpression: "SET #status = :failed, failedAt = :now, failureReason = :reason",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":now": Date.now(),
        ":reason": safeFailure(cause),
      },
    }));
    if (job.commentId && job.commentCreatedAt !== undefined) {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: {
          PK: `TICKET#${job.ticketId}`,
          SK: `COMMENT#${String(job.commentCreatedAt).padStart(15, "0")}#${job.commentId}`,
        },
        UpdateExpression: "SET deliveryStatus = :failed, deliveryUpdatedAt = :now, deliveryFailureReason = :reason",
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":now": Date.now(),
          ":reason": safeFailure(cause),
        },
      }));
    }
    console.error(JSON.stringify({ event: "ticket.email.failed", ticketId: job.ticketId, jobId: job.jobId }));
    throw cause;
  }
}

async function sendEmail(
  job: Job,
  email: ReturnType<typeof render>,
  replyTo: string | undefined,
  referenceSecret: string,
): Promise<string> {
  const provider = required("TICKET_EMAIL_PROVIDER");
  if (provider === "resend") {
    const result = await sendResendEmail({
      from: required("RESEND_FROM_ADDRESS"),
      to: job.recipient,
      ...(replyTo ? { replyTo } : {}),
      subject: email.subject,
      text: email.text,
      html: email.html,
      idempotencyKey: job.jobId,
      tags: [
        { name: "ticket_id", value: safeTag(job.ticketId) },
        { name: "event_id", value: safeTag(job.eventId) },
        { name: "recipient_type", value: job.recipientType },
        ...(job.commentId ? [{ name: "comment_id", value: safeTag(job.commentId) }] : []),
        ...(job.commentCreatedAt !== undefined
          ? [{ name: "comment_created_at", value: String(job.commentCreatedAt) }]
          : []),
      ],
    }, await resendApiKey());
    return result.messageId;
  }
  if (provider === "brevo") {
    const reference = makeEmailReference({
      ticketId: job.ticketId,
      eventId: job.eventId,
      recipientType: job.recipientType,
      ...(job.commentId ? { commentId: job.commentId } : {}),
      ...(job.commentCreatedAt !== undefined ? { commentCreatedAt: job.commentCreatedAt } : {}),
    }, referenceSecret);
    const result = await sendBrevoEmail({
      from: required("BREVO_FROM_ADDRESS"),
      to: job.recipient,
      ...(replyTo ? { replyTo } : {}),
      subject: email.subject,
      text: email.text,
      html: email.html,
      idempotencyKey: job.jobId,
      reference,
    }, await brevoApiKey());
    return result.messageId;
  }
  if (provider !== "ses") throw new Error(`Unsupported ticket email provider ${provider}`);

  const sent = await ses.send(new SendEmailCommand({
    FromEmailAddress: required("SES_FROM_ADDRESS"),
    Destination: { ToAddresses: [job.recipient] },
    ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: email.text, Charset: "UTF-8" },
          Html: { Data: email.html, Charset: "UTF-8" },
        },
      },
    },
    ...(process.env["SES_CONFIGURATION_SET"]
      ? { ConfigurationSetName: process.env["SES_CONFIGURATION_SET"] }
      : {}),
    EmailTags: [
      { Name: "ticket_id", Value: safeTag(job.ticketId) },
      { Name: "notification", Value: safeTag(job.jobId) },
      { Name: "event_id", Value: safeTag(job.eventId) },
      { Name: "recipient_type", Value: job.recipientType },
      ...(job.commentId ? [{ Name: "comment_id", Value: safeTag(job.commentId) }] : []),
      ...(job.commentCreatedAt !== undefined
        ? [{ Name: "comment_created_at", Value: String(job.commentCreatedAt) }]
        : []),
    ],
  }));
  return sent.MessageId ?? "unknown";
}

function render(job: Job, ticket: Record<string, unknown>, publicReply: string) {
  const subject = string(ticket["subject"]) || "Your support request";
  const name = string(ticket["requesterName"]) || "there";
  const adminUrl = `${required("ADMIN_APP_URL")}#tickets/${encodeURIComponent(job.ticketId)}`;
  if (job.template === "ticket-created-customer") {
    const text = `Hi ${name},\n\nWe received your request ${job.ticketId}: ${subject}\n\nOur team will follow up by email.\n\n--- Reply above this line ---`;
    return { subject: `[${job.ticketId}] We received your request`, text, html: paragraphs(text) };
  }
  if (job.template === "ticket-created-merchant") {
    const summary = string(ticket["summary"]);
    const text = `New customer ticket ${job.ticketId}\n\n${subject}\n\n${summary}\n\nOpen it in Shopify admin: ${adminUrl}`;
    return { subject: `[${job.ticketId}] New customer ticket`, text, html: paragraphs(text, adminUrl) };
  }
  if (job.template === "customer-replied-merchant") {
    const text = `Customer replied to ${job.ticketId}\n\n${subject}\n\n${publicReply}\n\nOpen it in Shopify admin: ${adminUrl}`;
    return { subject: `[${job.ticketId}] Customer replied`, text, html: paragraphs(text, adminUrl) };
  }
  const text = `Hi ${name},\n\n${publicReply || "The support team replied to your request."}\n\nTicket: ${job.ticketId}\n\n--- Reply above this line ---`;
  return { subject: `Re: [${job.ticketId}] ${subject}`, text, html: paragraphs(text) };
}

function paragraphs(text: string, link?: string): string {
  const body = text.split("\n\n").map((value) => `<p>${escapeHtml(value)}</p>`).join("");
  return link ? `${body}<p><a href="${escapeHtml(link)}">Open ticket in Shopify admin</a></p>` : body;
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
const string = (value: unknown) => typeof value === "string" ? value : "";
const safeTag = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
const safeFailure = (cause: unknown) => (cause as { name?: string }).name ?? "EmailDeliveryError";
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function replySecret(): Promise<string> {
  if (cachedReplySecret) return cachedReplySecret;
  cachedReplySecret = await createSecretsManagerProvider({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  }).get(required("PROXY_SECRET_ARN"));
  return cachedReplySecret;
}

async function brevoApiKey(): Promise<string> {
  if (cachedBrevoApiKey) return cachedBrevoApiKey;
  cachedBrevoApiKey = await createSecretsManagerProvider({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  }).get(required("BREVO_API_KEY_SECRET_ARN"));
  return cachedBrevoApiKey;
}

async function resendApiKey(): Promise<string> {
  if (cachedResendApiKey) return cachedResendApiKey;
  cachedResendApiKey = await createSecretsManagerProvider({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  }).get(required("RESEND_API_KEY_SECRET_ARN"));
  return cachedResendApiKey;
}
