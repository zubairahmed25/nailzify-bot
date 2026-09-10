import { recordDeliveryUpdate, type DeliveryStatus } from "./delivery-update.js";

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

export async function handler(event: SesEvent): Promise<void> {
  const status = statusFor(event.detail?.eventType?.toUpperCase() ?? "");
  if (!status) return;
  const tags = event.detail?.mail?.tags ?? {};
  const ticketId = first(tags, "ticket_id");
  const eventId = first(tags, "event_id");
  const recipientType = first(tags, "recipient_type");
  if (!ticketId || !eventId || (recipientType !== "customer" && recipientType !== "merchant")) return;

  const commentId = first(tags, "comment_id");
  const commentCreatedAt = Number(first(tags, "comment_created_at"));
  const eventTime = event.time ? Date.parse(event.time) : Number.NaN;
  await recordDeliveryUpdate({
    reference: {
      ticketId,
      eventId,
      recipientType,
      ...(commentId ? { commentId } : {}),
      ...(Number.isFinite(commentCreatedAt) ? { commentCreatedAt } : {}),
    },
    messageId: event.detail?.mail?.messageId ?? "unknown",
    status,
    at: Number.isFinite(eventTime) ? eventTime : Date.now(),
  });
}

function statusFor(type: string): DeliveryStatus | null {
  return ({
    SEND: "sent",
    DELIVERY: "delivered",
    DELIVERYDELAY: "delayed",
    BOUNCE: "bounced",
    COMPLAINT: "complained",
    REJECT: "failed",
    RENDERINGFAILURE: "failed",
  } as Record<string, DeliveryStatus>)[type.replaceAll("_", "")] ?? null;
}

const first = (tags: Record<string, readonly string[]>, name: string) => tags[name]?.[0];
