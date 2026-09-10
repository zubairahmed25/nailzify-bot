export interface BrevoEmail {
  readonly from: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly idempotencyKey: string;
  readonly reference: string;
}

export interface BrevoSendResult {
  readonly messageId: string;
}

export class BrevoApiError extends Error {
  override readonly name = "BrevoApiError";
  constructor(readonly status: number, readonly code?: string) {
    super(`Brevo rejected the transactional email request with status ${status}`);
  }
}

export async function sendBrevoEmail(
  email: BrevoEmail,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<BrevoSendResult> {
  const response = await fetcher("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: email.from, name: "Support" },
      to: [{ email: email.to }],
      ...(email.replyTo ? { replyTo: { email: email.replyTo } } : {}),
      subject: email.subject,
      textContent: email.text,
      htmlContent: email.html,
      headers: {
        "Idempotency-Key": email.idempotencyKey,
        "X-Mailin-custom": email.reference,
      },
      tags: ["ticket-notification"],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await response.json().catch(() => ({})) as { messageId?: unknown; code?: unknown };
  if (!response.ok) {
    const code = typeof payload.code === "string" ? payload.code : undefined;
    if (code === "duplicate_parameter") return { messageId: `idempotent:${email.idempotencyKey}` };
    throw new BrevoApiError(response.status, code);
  }
  if (typeof payload.messageId !== "string" || !payload.messageId) {
    throw new BrevoApiError(response.status, "missing_message_id");
  }
  return { messageId: payload.messageId };
}
