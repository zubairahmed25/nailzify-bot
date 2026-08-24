/**
 * Mirrors UploadedDocument in
 * packages/adapters/src/dynamodb/ingestion-state.ts, as returned by
 * `GET /admin/api/uploads` (services/admin/src/handler.ts). Kept as a plain
 * duplicate rather than a shared import — this package builds independently
 * of the backend and has no dependency on it, the same relationship the
 * storefront widget has with services/api's types.
 */
export type UploadStatus = "processing" | "ready" | "failed";

export interface UploadedDocument {
  readonly documentId: string;
  readonly status: UploadStatus;
  readonly title: string | null;
  readonly docType: string | null;
  readonly errorMessage: string | null;
  readonly s3Key: string;
  readonly uploadedAt: string;
  readonly updatedAt: string;
}

export type TicketStatus = "new" | "open" | "pending" | "hold" | "solved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type DeliveryStatus = "queued" | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

export interface Ticket {
  readonly id: string;
  readonly sessionId: string;
  readonly requesterEmail: string;
  readonly requesterName: string | null;
  readonly subject: string;
  readonly reason: string;
  readonly summary: string;
  readonly addedDetail: string | null;
  readonly transcript: readonly { role: "user" | "assistant"; body: string; createdAt: number }[] | null;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly assigneeUserId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly firstRespondedAt: number | null;
  readonly solvedAt: number | null;
  readonly closedAt: number | null;
  readonly version: number;
}

export interface TicketComment {
  readonly id: string;
  readonly authorType: "customer" | "merchant" | "system";
  readonly authorId: string | null;
  readonly body: string;
  readonly visibility: "public" | "private";
  readonly channel: "chat" | "email" | "admin" | "system";
  readonly createdAt: number;
  readonly deliveryStatus?: DeliveryStatus;
  readonly deliveryUpdatedAt?: number;
  readonly deliveryFailureReason?: string;
}

export interface TicketEvent {
  readonly id: string;
  readonly actorType: "customer" | "merchant" | "system";
  readonly actorId: string | null;
  readonly type: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly createdAt: number;
}

export interface TicketNotificationJob {
  readonly id: string;
  readonly recipientType: "customer" | "merchant";
  readonly template: string;
  readonly status: "queued" | "processing" | "sent" | "failed";
  readonly attempts: number;
  readonly createdAt: number;
  readonly recipient: string;
  readonly deliveryStatus?: DeliveryStatus;
  readonly deliveryUpdatedAt?: number;
  readonly failureReason?: string;
}

export interface TicketDetail {
  readonly ticket: Ticket;
  readonly comments: readonly TicketComment[];
  readonly events: readonly TicketEvent[];
  readonly notificationJobs: readonly TicketNotificationJob[];
}
