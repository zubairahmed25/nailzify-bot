import { createSecretsManagerProvider } from "@nailzify/adapters";
import { Webhook } from "svix";
import { recordDeliveryUpdate, type DeliveryStatus } from "./delivery-update.js";
import { processInboundReply } from "./inbound-reply.js";
import { retrieveResendReceivedEmail, type ResendReceivedEmail } from "./resend-client.js";

interface FunctionUrlEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

interface ResendWebhookEvent {
  readonly type?: string;
  readonly created_at?: string;
  readonly data?: {
    readonly email_id?: string;
    readonly message_id?: string;
    readonly created_at?: string;
    readonly from?: string;
    readonly to?: readonly string[];
    readonly attachments?: readonly unknown[];
    readonly tags?: Readonly<Record<string, string>> | readonly {
      readonly name?: string;
      readonly value?: string;
    }[];
    readonly bounce?: { readonly message?: string };
    readonly reason?: string;
    readonly message?: string;
  };
}

let cachedWebhookSecret: string | undefined;
let cachedApiKey: string | undefined;

export async function handler(event: FunctionUrlEvent) {
  const rawBody = decodeBody(event);
  let payload: ResendWebhookEvent;
  try {
    new Webhook(await webhookSecret()).verify(rawBody, {
      "svix-id": requiredHeader(event.headers, "svix-id"),
      "svix-timestamp": requiredHeader(event.headers, "svix-timestamp"),
      "svix-signature": requiredHeader(event.headers, "svix-signature"),
    });
    payload = JSON.parse(rawBody) as ResendWebhookEvent;
  } catch {
    return response(401, "Invalid webhook signature");
  }

  if (payload.type === "email.received") {
    await processInbound(payload);
    return response(204);
  }

  const status = deliveryStatus(payload.type);
  if (status) await processDelivery(payload, status);
  return response(204);
}

async function processInbound(payload: ResendWebhookEvent): Promise<void> {
  const data = payload.data;
  const emailId = data?.email_id;
  if (!emailId) {
    rejectInbound("missing_email_id");
    return;
  }
  if ((data.attachments?.length ?? 0) > 0) {
    rejectInbound("attachments_not_supported", emailId);
    return;
  }

  const email = await retrieveResendReceivedEmail(emailId, await apiKey());
  if (email.attachments.length > 0) {
    rejectInbound("attachments_not_supported", emailId);
    return;
  }
  if (!senderAuthenticationPassed(email.authentication)) {
    rejectInbound("sender_authentication_failed", emailId);
    return;
  }

  await processInboundReply({
    messageId: email.message_id ?? data.message_id ?? email.id,
    recipients: unique([...email.to, ...(data.to ?? [])]),
    ...(mailboxAddress(email.from ?? data.from) ? { sender: mailboxAddress(email.from ?? data.from)! } : {}),
    ...(replyText(email) ? { body: replyText(email) } : {}),
    receivedAt: timestamp(email.created_at ?? data.created_at ?? payload.created_at),
  });
}

async function processDelivery(payload: ResendWebhookEvent, status: DeliveryStatus): Promise<void> {
  const data = payload.data;
  const tags = normalizeTags(data?.tags);
  const ticketId = tags["ticket_id"];
  const eventId = tags["event_id"];
  const recipientType = tags["recipient_type"];
  if (!ticketId || !eventId || (recipientType !== "customer" && recipientType !== "merchant")) {
    console.warn(JSON.stringify({
      event: "ticket.email.delivery.rejected",
      reason: "missing_reference_tags",
      messageId: data?.email_id,
    }));
    return;
  }

  const commentId = tags["comment_id"];
  const commentCreatedAt = Number(tags["comment_created_at"]);
  await recordDeliveryUpdate({
    reference: {
      ticketId,
      eventId,
      recipientType,
      ...(commentId ? { commentId } : {}),
      ...(Number.isFinite(commentCreatedAt) ? { commentCreatedAt } : {}),
    },
    messageId: data?.email_id ?? "unknown",
    status,
    at: timestamp(payload.created_at ?? data?.created_at),
    ...(["delayed", "bounced", "complained", "failed"].includes(status)
      ? { failureReason: data?.bounce?.message ?? data?.reason ?? data?.message ?? payload.type ?? "Resend delivery failure" }
      : {}),
  });
}

function deliveryStatus(type: string | undefined): DeliveryStatus | null {
  return ({
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.delivery_delayed": "delayed",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.failed": "failed",
    "email.suppressed": "failed",
  } as Record<string, DeliveryStatus>)[type ?? ""] ?? null;
}

function senderAuthenticationPassed(authentication: ResendReceivedEmail["authentication"]): boolean {
  if (!authentication) return false;
  if ([authentication.spf, authentication.dkim, authentication.dmarc].includes("fail")) return false;
  return authentication.dmarc === "pass" || (
    authentication.spf === "pass" && authentication.dkim === "pass"
  );
}

function replyText(email: ResendReceivedEmail): string {
  const text = email.text?.trim() || htmlToText(email.html ?? "");
  return text
    .split(/\n--- Reply above this line ---/i)[0]!
    .split(/\nOn .+ wrote:\s*$/im)[0]!
    .split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0]!
    .trim()
    .slice(0, 10_000);
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function mailboxAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angle = value.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

function normalizeTags(
  tags: ResendWebhookEvent["data"] extends infer _ ? NonNullable<ResendWebhookEvent["data"]>["tags"] : never,
): Record<string, string> {
  if (!tags) return {};
  if (!Array.isArray(tags)) return { ...tags } as Record<string, string>;
  return Object.fromEntries(tags.flatMap((tag) =>
    tag.name && tag.value ? [[tag.name, tag.value]] : [],
  ));
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function decodeBody(event: FunctionUrlEvent): string {
  const body = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

function requiredHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function webhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  cachedWebhookSecret = await secrets().get(required("RESEND_WEBHOOK_SECRET_ARN"));
  return cachedWebhookSecret;
}

async function apiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  cachedApiKey = await secrets().get(required("RESEND_API_KEY_SECRET_ARN"));
  return cachedApiKey;
}

function secrets() {
  return createSecretsManagerProvider({ region: process.env["AWS_REGION"] ?? "us-east-1" });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function rejectInbound(reason: string, messageId?: string) {
  console.warn(JSON.stringify({ event: "ticket.inbound.rejected", reason, messageId }));
}

function response(statusCode: number, body?: string) {
  return { statusCode, ...(body ? { body } : {}) };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const resendDeliveryStatusForTest = deliveryStatus;
export const resendSenderAuthenticationPassedForTest = senderAuthenticationPassed;
