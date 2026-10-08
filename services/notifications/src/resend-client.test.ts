import { describe, expect, it, vi } from "vitest";
import {
  ResendApiError,
  retrieveResendReceivedEmail,
  sendResendEmail,
} from "./resend-client.js";

describe("Resend email client", () => {
  const email = {
    from: "support@nailzify.com",
    to: "customer@example.com",
    replyTo: "reply+token@tickets.nailzify.com",
    subject: "Ticket update",
    text: "Hello",
    html: "<p>Hello</p>",
    idempotencyKey: "job-1",
    tags: [
      { name: "ticket_id", value: "TKT-1" },
      { name: "event_id", value: "event-1" },
      { name: "recipient_type", value: "customer" },
    ],
  } as const;

  it("sends an idempotent email with provider correlation tags", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "resend-email-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(sendResendEmail(email, "api-key", fetcher)).resolves.toEqual({ messageId: "resend-email-1" });
    const [url, request] = fetcher.mock.calls[0]!;
    const init = request!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toEqual(expect.objectContaining({
      authorization: "Bearer api-key",
      "idempotency-key": "job-1",
    }));
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      from: "Support <support@nailzify.com>",
      to: ["customer@example.com"],
      reply_to: "reply+token@tickets.nailzify.com",
      tags: email.tags,
    }));
  });

  it("fails with a safe provider error when Resend rejects a send", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      name: "validation_error",
      message: "private provider detail",
    }), { status: 422, headers: { "content-type": "application/json" } }));

    await expect(sendResendEmail(email, "bad-key", fetcher)).rejects.toEqual(
      expect.objectContaining<Partial<ResendApiError>>({
        name: "ResendApiError",
        status: 422,
        code: "validation_error",
      }),
    );
  });

  it("retrieves parsed inbound content without requesting inline image data", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: "received-1",
      from: "Taylor <customer@example.com>",
      to: ["reply+token@tickets.nailzify.com"],
      text: "I still need help.",
      attachments: [],
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(retrieveResendReceivedEmail("received-1", "api-key", fetcher)).resolves.toEqual(
      expect.objectContaining({ id: "received-1", text: "I still need help." }),
    );
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.resend.com/emails/receiving/received-1?html_format=cid",
    );
  });
});
