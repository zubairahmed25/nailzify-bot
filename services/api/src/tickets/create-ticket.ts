import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  SessionId,
  TicketEventId,
  TicketId,
  type ConversationRepository,
  type Ticket,
  type TicketEvent,
  type TicketNotificationJob,
  type TicketRepository,
} from "@nailzify/core";

export interface CreateTicketDeps {
  readonly conversations: ConversationRepository;
  readonly tickets: TicketRepository;
  readonly merchantRecipients: readonly string[];
  readonly hashingSecret: string;
  readonly now?: () => number;
}

export interface CreateTicketInput {
  readonly shop: string;
  readonly sessionId: string;
  readonly escalationId: string;
  readonly email: string;
  readonly name?: string;
  readonly addedDetail?: string;
  readonly includeTranscript: boolean;
}

export type CreateTicketResult =
  | { readonly ok: true; readonly ticket: Ticket; readonly created: boolean }
  | { readonly ok: false; readonly status: 400 | 404 | 409 | 422; readonly reason: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createTicketUseCase(deps: CreateTicketDeps) {
  return async (input: CreateTicketInput): Promise<CreateTicketResult> => {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return { ok: false, status: 422, reason: "Enter a valid email address" };
    }
    if (!input.shop || !input.sessionId || !input.escalationId) {
      return { ok: false, status: 400, reason: "Missing ticket confirmation details" };
    }

    const session = await deps.conversations.loadSession(SessionId(input.sessionId));
    if (!session) return { ok: false, status: 404, reason: "Conversation not found" };
    if (!session.escalated || !session.escalationId) {
      return { ok: false, status: 409, reason: "This conversation is not awaiting handoff" };
    }
    if (session.escalationId !== input.escalationId) {
      return { ok: false, status: 409, reason: "Handoff confirmation has expired" };
    }

    const now = deps.now?.() ?? Date.now();
    const id = TicketId(`TKT-${now.toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`);
    const eventId = TicketEventId(randomUUID());
    const messages = await deps.conversations.loadRecentMessages(session.id, 50);
    const question = [...messages].reverse().find((message) => message.role === "user")?.content
      ?? "Customer requested help";

    const ticket: Ticket = {
      id,
      shop: input.shop,
      escalationId: input.escalationId,
      sessionId: session.id,
      requesterEmail: email,
      requesterEmailHash: digest(deps.hashingSecret, `email:${email}`),
      requesterName: cleanOptional(input.name, 120),
      subject: cleanSubject(question),
      reason: session.escalationReason ?? "Human help requested",
      summary: session.escalationSummary ?? question,
      addedDetail: cleanOptional(input.addedDetail, 2_000),
      transcript: input.includeTranscript
        ? messages.map((message) => ({
            role: message.role,
            body: message.content,
            createdAt: message.createdAt,
          }))
        : null,
      sourceChannel: "chat",
      status: "new",
      priority: "normal",
      assigneeUserId: null,
      followUpToTicketId: null,
      replyTokenHash: digest(deps.hashingSecret, `reply:${id}`),
      createdAt: now,
      updatedAt: now,
      firstRespondedAt: null,
      solvedAt: null,
      closedAt: null,
      version: 0,
    };

    const createdEvent: TicketEvent = {
      id: eventId,
      ticketId: id,
      actorType: "customer",
      actorId: null,
      type: "created",
      before: null,
      after: { status: "new", sourceChannel: "chat", transcriptIncluded: input.includeTranscript },
      createdAt: now,
    };

    const notificationJobs: TicketNotificationJob[] = [
      notification(id, eventId, "customer", email, "ticket-created-customer", now),
      ...deps.merchantRecipients.slice(0, 1).map((recipient) =>
        notification(id, eventId, "merchant", recipient, "ticket-created-merchant", now),
      ),
    ];

    const result = await deps.tickets.create({ ticket, createdEvent, notificationJobs });
    return { ok: true, ticket: result.ticket, created: result.created };
  };
}

function notification(
  ticketId: TicketId,
  eventId: TicketEventId,
  recipientType: "customer" | "merchant",
  recipient: string,
  template: string,
  createdAt: number,
): TicketNotificationJob {
  return {
    id: `${ticketId}:${eventId}:${template}:${recipientType}`,
    ticketId,
    eventId,
    recipientType,
    template,
    recipient,
    status: "queued",
    attempts: 0,
    createdAt,
  };
}

function digest(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function cleanOptional(value: string | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanSubject(question: string): string {
  const cleaned = question.replace(/\s+/g, " ").trim();
  return (cleaned || "Customer requested help").slice(0, 160);
}
