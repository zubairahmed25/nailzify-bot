import { timingSafeEqual } from "node:crypto";
import { createSecretsManagerProvider } from "@nailzify/adapters";
import { recordDeliveryUpdate, type DeliveryStatus } from "./delivery-update.js";
import { verifyEmailReference } from "./email-reference.js";
import { processInboundReply } from "./inbound-reply.js";

interface FunctionUrlEvent {
  readonly rawPath?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

interface Mailbox { readonly Address?: string }
interface BrevoInboundItem {
  readonly MessageId?: string;
  readonly From?: Mailbox;
  readonly To?: readonly (Mailbox | string)[];
  readonly Recipients?: readonly (Mailbox | string)[];
  readonly SentAtDate?: string;
  readonly ExtractedMarkdownMessage?: string;
  readonly Attachments?: readonly unknown[];
  readonly Spam?: { readonly Score?: number };
  readonly SpamScore?: number;
}

interface BrevoDeliveryEvent {
  readonly event?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly ts_epoch?: number;
  readonly ts_event?: number;
  readonly ts?: number;
  readonly "message-id"?: string;
  readonly "X-Mailin-custom"?: string;
}

let cachedWebhookSecret: string | undefined;
let cachedReferenceSecret: string | undefined;

export async function handler(event: FunctionUrlEvent) {
  if (!await authorized(event.headers ?? {})) return response(401, "Unauthorized");

  let payload: unknown;
  try {
    const body = event.body ?? "";
    payload = JSON.parse(event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
  } catch {
    return response(400, "Invalid JSON");
  }

  if (event.rawPath?.endsWith("/inbound")) {
    await processInboundPayload(payload);
    return response(204);
  }
  if (event.rawPath?.endsWith("/delivery")) {
    await processDeliveryPayload(payload);
    return response(204);
  }
  return response(404, "Not found");
}

async function processInboundPayload(payload: unknown): Promise<void> {
  const items = object(payload)?.["items"];
  if (!Array.isArray(items)) throw new Error("Brevo inbound payload is missing items");
  const threshold = numberEnvironment("BREVO_INBOUND_SPAM_SCORE_MAX");

  for (const raw of items) {
    const item = raw as BrevoInboundItem;
    if ((item.Attachments?.length ?? 0) > 0) {
      rejectInbound("attachments_not_supported", item.MessageId);
      continue;
    }
    const score = inboundSpamScore(item);
    if (score === null || score > threshold) {
      rejectInbound(score === null ? "missing_spam_score" : "spam_score_failed", item.MessageId);
      continue;
    }
    await processInboundReply({
      ...(item.MessageId ? { messageId: item.MessageId } : {}),
      recipients: [...mailboxes(item.Recipients), ...mailboxes(item.To)],
      ...(item.From?.Address ? { sender: item.From.Address } : {}),
      ...(item.ExtractedMarkdownMessage ? { body: item.ExtractedMarkdownMessage } : {}),
      receivedAt: Date.parse(item.SentAtDate ?? "") || Date.now(),
    });
  }
}

async function processDeliveryPayload(payload: unknown): Promise<void> {
  const events = Array.isArray(payload) ? payload : [payload];
  const secret = await referenceSecret();
  for (const raw of events) {
    const item = raw as BrevoDeliveryEvent;
    const status = deliveryStatus(item.event);
    if (!status) continue;
    const reference = item["X-Mailin-custom"]
      ? verifyEmailReference(item["X-Mailin-custom"], secret)
      : null;
    if (!reference) {
      console.warn(JSON.stringify({ event: "ticket.email.delivery.rejected", reason: "invalid_reference" }));
      continue;
    }
    await recordDeliveryUpdate({
      reference,
      messageId: item["message-id"] ?? "unknown",
      status,
      at: eventTimestamp(item),
      ...(["delayed", "bounced", "complained", "failed"].includes(status)
        ? { failureReason: item.reason ?? item.message ?? item.event ?? "Brevo delivery failure" }
        : {}),
    });
  }
}

function deliveryStatus(event: string | undefined): DeliveryStatus | null {
  const normalized = event?.replace(/[_\s-]/g, "").toLowerCase() ?? "";
  return ({
    request: "sent",
    sent: "sent",
    delivered: "delivered",
    deferred: "delayed",
    softbounce: "delayed",
    hardbounce: "bounced",
    invalidemail: "bounced",
    invalid: "bounced",
    spam: "complained",
    complaint: "complained",
    unsubscribed: "complained",
    blocked: "failed",
    error: "failed",
  } as Record<string, DeliveryStatus>)[normalized] ?? null;
}

function inboundSpamScore(item: BrevoInboundItem): number | null {
  const score = item.Spam?.Score ?? item.SpamScore;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

function mailboxes(values: readonly (Mailbox | string)[] | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    if (typeof value === "string") return [value];
    return value.Address ? [value.Address] : [];
  });
}

function eventTimestamp(item: BrevoDeliveryEvent): number {
  const value = item.ts_epoch ?? item.ts_event ?? item.ts;
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

async function authorized(headers: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const authorization = header(headers, "authorization");
  const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supplied) return false;
  const expected = await webhookSecret();
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string) {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

async function webhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  cachedWebhookSecret = await secrets().get(required("BREVO_WEBHOOK_SECRET_ARN"));
  return cachedWebhookSecret;
}

async function referenceSecret(): Promise<string> {
  if (cachedReferenceSecret) return cachedReferenceSecret;
  cachedReferenceSecret = await secrets().get(required("PROXY_SECRET_ARN"));
  return cachedReferenceSecret;
}

function secrets() {
  return createSecretsManagerProvider({ region: process.env["AWS_REGION"] ?? "us-east-1" });
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function numberEnvironment(name: string): number {
  const value = Number(required(name));
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number`);
  return value;
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

export const brevoDeliveryStatusForTest = deliveryStatus;
export const brevoSpamScoreForTest = inboundSpamScore;
