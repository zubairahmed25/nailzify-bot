export interface ResendEmailTag {
  readonly name: string;
  readonly value: string;
}

export interface ResendEmail {
  readonly from: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly idempotencyKey: string;
  readonly tags: readonly ResendEmailTag[];
}

export interface ResendSendResult {
  readonly messageId: string;
}

export interface ResendReceivedEmail {
  readonly id: string;
  readonly from?: string;
  readonly to: readonly string[];
  readonly created_at?: string;
  readonly text?: string | null;
  readonly html?: string | null;
  readonly message_id?: string;
  readonly attachments: readonly unknown[];
  readonly authentication?: {
    readonly spf?: string;
    readonly dkim?: string;
    readonly dmarc?: string;
  } | null;
}

export class ResendApiError extends Error {
  override readonly name = "ResendApiError";
  constructor(readonly status: number, readonly code?: string) {
    super(`Resend rejected the email API request with status ${status}`);
  }
}

export async function sendResendEmail(
  email: ResendEmail,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ResendSendResult> {
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": email.idempotencyKey,
    },
    body: JSON.stringify({
      from: `Support <${email.from}>`,
      to: [email.to],
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      subject: email.subject,
      text: email.text,
      html: email.html,
      tags: email.tags,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await response.json().catch(() => ({})) as {
    id?: unknown;
    name?: unknown;
    statusCode?: unknown;
  };
  if (!response.ok) {
    const code = typeof payload.name === "string" ? payload.name : undefined;
    throw new ResendApiError(response.status, code);
  }
  if (typeof payload.id !== "string" || !payload.id) {
    throw new ResendApiError(response.status, "missing_email_id");
  }
  return { messageId: payload.id };
}

export async function retrieveResendReceivedEmail(
  emailId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ResendReceivedEmail> {
  const response = await fetcher(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`,
    {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await response.json().catch(() => ({})) as Partial<ResendReceivedEmail> & {
    name?: unknown;
  };
  if (!response.ok) {
    const code = typeof payload.name === "string" ? payload.name : undefined;
    throw new ResendApiError(response.status, code);
  }
  if (typeof payload.id !== "string" || !Array.isArray(payload.to)) {
    throw new ResendApiError(response.status, "invalid_received_email");
  }
  return {
    id: payload.id,
    ...(typeof payload.from === "string" ? { from: payload.from } : {}),
    to: payload.to.filter((value): value is string => typeof value === "string"),
    ...(typeof payload.created_at === "string" ? { created_at: payload.created_at } : {}),
    ...(typeof payload.text === "string" || payload.text === null ? { text: payload.text } : {}),
    ...(typeof payload.html === "string" || payload.html === null ? { html: payload.html } : {}),
    ...(typeof payload.message_id === "string" ? { message_id: payload.message_id } : {}),
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    ...(payload.authentication && typeof payload.authentication === "object"
      ? { authentication: payload.authentication }
      : { authentication: null }),
  };
}
