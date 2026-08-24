import { describe, expect, it } from "vitest";
import { SessionId, TicketId } from "../shared/brand.js";
import {
  InvalidTicketTransition,
  transitionTicket,
  type Ticket,
} from "./ticket.js";

const ticket = (status: Ticket["status"] = "new"): Ticket => ({
  id: TicketId("01JTEST"),
  shop: "nailzify.myshopify.com",
  escalationId: "esc-1",
  sessionId: SessionId("session-1"),
  requesterEmail: "customer@example.com",
  requesterEmailHash: "hash",
  requesterName: null,
  subject: "Need help",
  reason: "policy_missing",
  summary: "Customer needs help",
  addedDetail: null,
  transcript: null,
  sourceChannel: "chat",
  status,
  priority: "normal",
  assigneeUserId: null,
  followUpToTicketId: null,
  replyTokenHash: "token-hash",
  createdAt: 100,
  updatedAt: 100,
  firstRespondedAt: null,
  solvedAt: null,
  closedAt: null,
  version: 0,
});

describe("ticket lifecycle", () => {
  it("moves a new ticket into active merchant work", () => {
    const updated = transitionTicket(ticket(), "open", 200);
    expect(updated.status).toBe("open");
    expect(updated.updatedAt).toBe(200);
    expect(updated.version).toBe(1);
  });

  it("reopens a solved ticket when the customer replies", () => {
    const solved = { ...ticket("solved"), solvedAt: 150 };
    const reopened = transitionTicket(solved, "open", 200);
    expect(reopened.status).toBe("open");
    expect(reopened.solvedAt).toBeNull();
  });

  it("allows scheduled closure only after solve", () => {
    expect(transitionTicket(ticket("solved"), "closed", 300).closedAt).toBe(300);
    expect(() => transitionTicket(ticket("open"), "closed", 300)).toThrow(
      InvalidTicketTransition,
    );
  });

  it("keeps closed tickets immutable", () => {
    expect(() => transitionTicket(ticket("closed"), "open", 300)).toThrow(
      /cannot move from closed to open/i,
    );
  });

  it("does not bump the version for a no-op", () => {
    const pending = ticket("pending");
    expect(transitionTicket(pending, "pending", 300)).toBe(pending);
  });
});
