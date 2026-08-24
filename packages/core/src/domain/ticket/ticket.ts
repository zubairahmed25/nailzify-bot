import type {
  SessionId,
  TicketCommentId,
  TicketEventId,
  TicketId,
} from "../shared/brand.js";

export const TICKET_STATUSES = ["new", "open", "pending", "hold", "solved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type TicketAuthorType = "customer" | "merchant" | "system";
export type TicketVisibility = "public" | "private";
export type TicketChannel = "chat" | "email" | "admin" | "system";

export type DeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "failed";

export interface TicketTranscriptMessage {
  readonly role: "user" | "assistant";
  readonly body: string;
  readonly createdAt: number;
}

export interface Ticket {
  readonly id: TicketId;
  readonly shop: string;
  readonly escalationId: string;
  readonly sessionId: SessionId;
  readonly requesterEmail: string;
  readonly requesterEmailHash: string;
  readonly requesterName: string | null;
  readonly subject: string;
  readonly reason: string;
  readonly summary: string;
  readonly addedDetail: string | null;
  readonly transcript: readonly TicketTranscriptMessage[] | null;
  readonly sourceChannel: "chat";
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly assigneeUserId: string | null;
  readonly followUpToTicketId: TicketId | null;
  readonly replyTokenHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly firstRespondedAt: number | null;
  readonly solvedAt: number | null;
  readonly closedAt: number | null;
  readonly version: number;
}

export interface TicketComment {
  readonly id: TicketCommentId;
  readonly ticketId: TicketId;
  readonly authorType: TicketAuthorType;
  readonly authorId: string | null;
  readonly body: string;
  readonly visibility: TicketVisibility;
  readonly channel: TicketChannel;
  readonly createdAt: number;
  readonly inboundMessageId?: string;
  readonly outboundMessageId?: string;
  readonly deliveryStatus?: DeliveryStatus;
  readonly deliveryUpdatedAt?: number;
  readonly deliveryFailureReason?: string;
}

export type TicketEventType =
  | "created"
  | "status_changed"
  | "priority_changed"
  | "assigned"
  | "public_reply_added"
  | "private_note_added"
  | "delivery_updated"
  | "reopened"
  | "follow_up_created";

export interface TicketEvent {
  readonly id: TicketEventId;
  readonly ticketId: TicketId;
  readonly actorType: TicketAuthorType;
  readonly actorId: string | null;
  readonly type: TicketEventType;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
}

export interface TicketNotificationJob {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly eventId: TicketEventId;
  readonly recipientType: "customer" | "merchant";
  readonly template: string;
  readonly recipient: string;
  readonly status: "queued" | "processing" | "sent" | "failed";
  readonly attempts: number;
  readonly createdAt: number;
  readonly commentId?: TicketCommentId;
  readonly commentCreatedAt?: number;
  readonly deliveryStatus?: DeliveryStatus;
  readonly deliveryUpdatedAt?: number;
  readonly outboundMessageId?: string;
  readonly failureReason?: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  new: ["open", "pending", "hold", "solved"],
  open: ["pending", "hold", "solved"],
  pending: ["open", "hold", "solved"],
  hold: ["open", "pending", "solved"],
  solved: ["open", "closed"],
  closed: [],
};

export class InvalidTicketTransition extends Error {
  readonly code = "INVALID_TICKET_TRANSITION";

  constructor(readonly from: TicketStatus, readonly to: TicketStatus) {
    super(`Ticket cannot move from ${from} to ${to}`);
  }
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionTicket(ticket: Ticket, status: TicketStatus, now: number): Ticket {
  if (!canTransitionTicket(ticket.status, status)) {
    throw new InvalidTicketTransition(ticket.status, status);
  }
  if (ticket.status === status) return ticket;

  return {
    ...ticket,
    status,
    updatedAt: now,
    solvedAt: status === "solved" ? now : status === "open" ? null : ticket.solvedAt,
    closedAt: status === "closed" ? now : ticket.closedAt,
    version: ticket.version + 1,
  };
}

export function updateTicketPriority(
  ticket: Ticket,
  priority: TicketPriority,
  now: number,
): Ticket {
  if (ticket.status === "closed") throw new InvalidTicketTransition("closed", "closed");
  if (ticket.priority === priority) return ticket;
  return { ...ticket, priority, updatedAt: now, version: ticket.version + 1 };
}

export function assignTicket(ticket: Ticket, assigneeUserId: string | null, now: number): Ticket {
  if (ticket.status === "closed") throw new InvalidTicketTransition("closed", "closed");
  if (ticket.assigneeUserId === assigneeUserId) return ticket;
  return { ...ticket, assigneeUserId, updatedAt: now, version: ticket.version + 1 };
}
