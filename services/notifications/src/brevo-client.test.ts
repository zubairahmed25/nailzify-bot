import { describe, expect, it, vi } from "vitest";
import { BrevoApiError, sendBrevoEmail } from "./brevo-client.js";

describe("Brevo transactional email client", () => {
  const email = {
    from: "support@nailzify.com",
    to: "customer@example.com",
    replyTo: "reply+token@tickets.nailzify.com",
    subject: "Ticket update",
    text: "Hello",
    html: "<p>Hello</p>",
    idempotencyKey: "job-1",
    reference: "signed-reference",
  };

  it("sends the provider correlation and idempotency values without recipient tags", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ messageId: "brevo-message-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));

    await expect(sendBrevoEmail(email, "api-key", fetcher)).resolves.toEqual({ messageId: "brevo-message-1" });
    const request = fetcher.mock.calls[0]![1]!;
    const body = JSON.parse(String(request.body));
    expect(request.headers).toEqual(expect.objectContaining({ "api-key": "api-key" }));
    expect(body).toEqual(expect.objectContaining({
      sender: { email: "support@nailzify.com", name: "Support" },
      to: [{ email: "customer@example.com" }],
      replyTo: { email: "reply+token@tickets.nailzify.com" },
      headers: {
        "Idempotency-Key": "job-1",
        "X-Mailin-custom": "signed-reference",
      },
      tags: ["ticket-notification"],
    }));
  });

  it("fails with a safe provider error when Brevo rejects the request", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ code: "unauthorized", message: "secret detail" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    await expect(sendBrevoEmail(email, "bad-key", fetcher)).rejects.toEqual(
      expect.objectContaining<Partial<BrevoApiError>>({ name: "BrevoApiError", status: 401, code: "unauthorized" }),
    );
  });

  it("treats an idempotency replay as sent so a lost API response does not fail the job", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ code: "duplicate_parameter" }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    await expect(sendBrevoEmail(email, "api-key", fetcher)).resolves.toEqual({ messageId: "idempotent:job-1" });
  });
});
