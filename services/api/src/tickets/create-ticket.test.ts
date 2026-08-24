import { describe, expect, it } from "vitest";
import {
  MessageId,
  SessionId,
  createSession,
  escalate,
  type ConversationRepository,
  type Message,
  type TicketRepository,
} from "@nailzify/core";
import { createTicketUseCase } from "./create-ticket.js";

const NOW = 1_700_000_000_000;
const session = escalate(createSession(SessionId("session-1"), null, NOW), NOW, {
  id: "handoff-1",
  reason: "Shipping policy unavailable",
  summary: "Customer asked whether shipping is free",
});
const history: Message[] = [
  { id: MessageId("message-1"), role: "user", content: "Is shipping free?", createdAt: NOW - 1 },
  { id: MessageId("message-2"), role: "assistant", content: "I can ask the team.", createdAt: NOW },
];

function build() {
  const created: Parameters<TicketRepository["create"]>[0][] = [];
  const conversations: ConversationRepository = {
    async loadSession() { return session; },
    async createSession() {}, async saveSession() {},
    async loadRecentMessages() { return history; }, async appendMessages() {},
    async findSessionsByCustomer() { return []; },
  };
  const tickets: TicketRepository = {
    async create(record) { created.push(record); return { ticket: record.ticket, created: true }; },
    async load() { return null; }, async list() { return { items: [], cursor: null }; },
    async loadTimeline() { return { comments: [], events: [], notificationJobs: [] }; },
    async save() {}, async addComment() {}, async retryNotification() {},
  };
  return {
    run: createTicketUseCase({
      conversations,
      tickets,
      merchantRecipients: ["care@nailzify.com"],
      hashingSecret: "test-secret",
      now: () => NOW,
    }),
    created,
  };
}

describe("customer ticket confirmation", () => {
  it("uses the server trusted handoff and queues both acknowledgements", async () => {
    const { run, created } = build();
    const result = await run({
      shop: "nailzify.myshopify.com", sessionId: "session-1", escalationId: "handoff-1",
      email: " Customer@Example.com ", includeTranscript: false,
    });
    expect(result.ok).toBe(true);
    expect(created[0]!.ticket.reason).toBe("Shipping policy unavailable");
    expect(created[0]!.ticket.requesterEmail).toBe("customer@example.com");
    expect(created[0]!.ticket.transcript).toBeNull();
    expect(created[0]!.notificationJobs.map((job) => job.recipientType)).toEqual(["customer", "merchant"]);
  });

  it("includes transcript only after explicit consent", async () => {
    const { run, created } = build();
    await run({
      shop: "nailzify.myshopify.com", sessionId: "session-1", escalationId: "handoff-1",
      email: "customer@example.com", includeTranscript: true,
    });
    expect(created[0]!.ticket.transcript).toHaveLength(2);
  });

  it("rejects a forged or stale handoff id", async () => {
    const { run, created } = build();
    const result = await run({
      shop: "nailzify.myshopify.com", sessionId: "session-1", escalationId: "wrong",
      email: "customer@example.com", includeTranscript: false,
    });
    expect(result).toEqual({ ok: false, status: 409, reason: "Handoff confirmation has expired" });
    expect(created).toHaveLength(0);
  });
});
