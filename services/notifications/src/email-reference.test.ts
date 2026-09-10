import { describe, expect, it } from "vitest";
import { makeEmailReference, verifyEmailReference } from "./email-reference.js";

describe("ticket email reference", () => {
  const reference = {
    ticketId: "TKT-1",
    eventId: "event-1",
    recipientType: "customer" as const,
    commentId: "comment-1",
    commentCreatedAt: 100,
  };

  it("round trips provider metadata without exposing the signing secret", () => {
    const encoded = makeEmailReference(reference, "secret");
    expect(encoded).not.toContain("secret");
    expect(verifyEmailReference(encoded, "secret")).toEqual(reference);
  });

  it("rejects a changed or incorrectly signed reference", () => {
    const encoded = makeEmailReference(reference, "secret");
    expect(verifyEmailReference(`${encoded}x`, "secret")).toBeNull();
    expect(verifyEmailReference(encoded, "other-secret")).toBeNull();
  });
});
