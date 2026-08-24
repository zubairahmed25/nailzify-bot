import type { Ticket, TicketDetail, TicketPriority, TicketStatus, UploadedDocument } from "./types.js";

/**
 * Relative paths, deliberately. This page is served from the same CloudFront
 * distribution as `/admin/api/*` (infra/lib/api-stack.ts) — there is no
 * separate API origin to configure, and hard-coding one would be one more
 * thing to keep in sync across environments for no benefit.
 */
const BASE = "/admin/api/uploads";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * `window.shopify` only exists inside an embedded Shopify admin iframe — see
 * env.d.ts and the script tag in index.html. Failing with a clear, actionable
 * message here beats a cryptic "Cannot read properties of undefined" the
 * first time someone opens this page directly instead of through Shopify.
 */
async function getSessionToken(): Promise<string> {
  if (!window.shopify) {
    throw new Error(
      "App Bridge is not available. Open this page from the Shopify admin, not directly.",
    );
  }
  return window.shopify.idToken();
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getSessionToken();
  const response = await fetch(path, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return response;
}

export async function listUploads(): Promise<readonly UploadedDocument[]> {
  const response = await authed(BASE, { method: "GET" });
  const body = (await response.json()) as { documents: UploadedDocument[] };
  return body.documents;
}

/**
 * `purpose` (e.g. "Returns", "About Us") is what the merchant types to say
 * what this document is — it becomes both the document's title and its
 * identity server-side (services/admin/src/composition-root.ts), which is
 * why there is no `filename` parameter here at all. Whatever the picked
 * file happens to be called on the merchant's computer never leaves the
 * browser.
 */
export async function createUpload(
  purpose: string,
): Promise<{ documentId: string; uploadUrl: string }> {
  const response = await authed(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose }),
  });
  return (await response.json()) as { documentId: string; uploadUrl: string };
}

/**
 * The one call in this file NOT sent through `authed()` — it goes straight to
 * S3, not to our Lambda. The presigned URL itself is the credential; adding a
 * Shopify Authorization header here would do nothing useful and could only
 * confuse S3's own signature check.
 */
export async function putFile(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, { method: "PUT", body: file });
  if (!response.ok) {
    throw new Error(`Upload to storage failed (${response.status})`);
  }
}

export async function deleteUpload(documentId: string): Promise<void> {
  await authed(`${BASE}/${encodeURIComponent(documentId)}`, { method: "DELETE" });
}

const TICKETS_BASE = "/admin/api/tickets";

export async function listTickets(statuses: readonly TicketStatus[]): Promise<readonly Ticket[]> {
  const query = new URLSearchParams({ status: statuses.join(","), limit: "100" });
  const response = await authed(`${TICKETS_BASE}?${query}`, { method: "GET" });
  const body = await response.json() as { items: Ticket[] };
  return body.items;
}

export async function getTicket(id: string): Promise<TicketDetail> {
  const response = await authed(`${TICKETS_BASE}/${encodeURIComponent(id)}`, { method: "GET" });
  return await response.json() as TicketDetail;
}

export async function updateTicket(
  id: string,
  expectedVersion: number,
  update: { status: TicketStatus } | { priority: TicketPriority } | { assigneeUserId: string | null },
): Promise<Ticket> {
  const response = await authed(`${TICKETS_BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion, ...update }),
  });
  return (await response.json() as { ticket: Ticket }).ticket;
}

export async function addTicketComment(
  id: string,
  input: {
    expectedVersion: number;
    body: string;
    visibility: "public" | "private";
    nextStatus: TicketStatus;
  },
): Promise<void> {
  await authed(`${TICKETS_BASE}/${encodeURIComponent(id)}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function retryTicketNotification(ticketId: string, jobId: string): Promise<void> {
  await authed(
    `${TICKETS_BASE}/${encodeURIComponent(ticketId)}/notifications/${encodeURIComponent(jobId)}/retry`,
    { method: "POST" },
  );
}
