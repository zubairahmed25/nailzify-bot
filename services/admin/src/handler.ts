/**
 * Admin Lambda — request pipeline.
 *
 * Behind a plain (non-streaming) Lambda Function URL, unlike the chat Lambda.
 * Nothing here is long-running or benefits from SSE: a presigned URL and a
 * DynamoDB query both return in milliseconds, so the ordinary buffered
 * invocation mode is the right one and needs none of handler.ts in
 * services/api's `awslambda.HttpResponseStream` machinery.
 *
 * ORDER OF OPERATIONS: session token first, same reasoning as the chat
 * Lambda's "signature before schema before spend" — reject the cheapest way
 * before doing any DynamoDB or S3 work.
 */

import type { AdminDeps } from "./composition-root.js";
import { verifySessionToken } from "./security/verify-session-token.js";
import { randomUUID } from "node:crypto";
import {
  TicketCommentId,
  TicketEventId,
  TicketId,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  assignTicket,
  transitionTicket,
  updateTicketPriority,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketNotificationJob,
  type TicketPriority,
  type TicketStatus,
} from "@nailzify/core";

export interface AdminEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
}

export interface AdminResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const UPLOADS_PATH = /^\/admin\/api\/uploads\/?$/;
const UPLOAD_ITEM_PATH = /^\/admin\/api\/uploads\/([^/]+)$/;
const TICKETS_PATH = /^\/admin\/api\/tickets\/?$/;
const TICKET_ITEM_PATH = /^\/admin\/api\/tickets\/([^/]+)$/;
const TICKET_COMMENTS_PATH = /^\/admin\/api\/tickets\/([^/]+)\/comments$/;
const TICKET_RETRY_PATH = /^\/admin\/api\/tickets\/([^/]+)\/notifications\/([^/]+)\/retry$/;

export async function handleAdminRequest(
  event: AdminEvent,
  deps: AdminDeps,
): Promise<AdminResponse> {
  const auth = verifySessionToken(
    headerValue(event.headers, "authorization"),
    deps.sessionSecret,
    deps.apiKey,
    deps.shopDomain,
  );
  // Deliberately vague in the RESPONSE, same as the App Proxy's 401 — the real
  // reason belongs in logs, not handed to whoever is knocking on the endpoint.
  // But it DOES belong in logs: without this, "Unauthorized" is the only
  // signal we ourselves get, which is indistinguishable between "no header
  // reached the Lambda at all" (a CloudFront forwarding problem) and "a
  // header arrived but failed one specific claim check" (a config problem) —
  // exactly the ambiguity this project has been burned by before with
  // unverified Shopify assumptions (docs/LESSONS.md).
  if (!auth.ok) {
    console.warn(JSON.stringify({ level: "WARN", msg: "admin.auth.rejected", reason: auth.reason }));
    return json(401, { error: "Unauthorized" });
  }

  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "";

  if (method === "GET" && TICKETS_PATH.test(path)) {
    const query = queryParams(event);
    const requested = query.get("status")?.split(",").filter(isTicketStatus);
    const statuses: readonly TicketStatus[] = requested?.length
      ? requested
      : ["new", "open", "pending", "hold"];
    const priorityValue = query.get("priority") ?? undefined;
    const priority = priorityValue && TICKET_PRIORITIES.includes(priorityValue as TicketPriority)
      ? priorityValue as TicketPriority
      : undefined;
    const page = await deps.tickets.list({
      shop: auth.shop,
      statuses,
      limit: Math.min(Math.max(Number(query.get("limit")) || 50, 1), 100),
      ...(priority ? { priority } : {}),
      ...(query.get("assignee") ? { assigneeUserId: query.get("assignee")! } : {}),
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    });
    return json(200, { ...page, items: page.items.map(ticketView) });
  }

  const commentMatch = TICKET_COMMENTS_PATH.exec(path);
  if (method === "POST" && commentMatch) {
    const ticket = await merchantTicket(deps, auth.shop, commentMatch[1]!);
    if (!ticket) return json(404, { error: "Ticket not found" });
    if (ticket.status === "closed") return json(422, { error: "Closed tickets cannot be changed" });
    const body = readJson(event);
    if (!body) return json(400, { error: "Body is not valid JSON" });
    const text = typeof body["body"] === "string" ? body["body"].trim() : "";
    const visibility = body["visibility"] === "private" ? "private" : "public";
    const expectedVersion = body["expectedVersion"];
    if (!text || text.length > 10_000) return json(422, { error: "Comment body is required" });
    if (typeof expectedVersion !== "number") return json(400, { error: "expectedVersion is required" });

    const now = Date.now();
    const nextStatusValue = body["nextStatus"];
    const nextStatus = typeof nextStatusValue === "string" && isTicketStatus(nextStatusValue)
      ? nextStatusValue
      : ticket.status;
    let updated: Ticket;
    try {
      updated = transitionTicket(ticket, nextStatus, now);
    } catch (cause) {
      return json(422, { error: (cause as Error).message });
    }
    updated = {
      ...updated,
      firstRespondedAt:
        visibility === "public" && updated.firstRespondedAt === null ? now : updated.firstRespondedAt,
      updatedAt: now,
      version: Math.max(updated.version, ticket.version + 1),
    };
    const commentId = TicketCommentId(randomUUID());
    const eventId = TicketEventId(randomUUID());
    const comment: TicketComment = {
      id: commentId,
      ticketId: ticket.id,
      authorType: "merchant",
      authorId: auth.userId,
      body: text,
      visibility,
      channel: "admin",
      createdAt: now,
      ...(visibility === "public" ? { deliveryStatus: "queued", deliveryUpdatedAt: now } : {}),
    };
    const audit: TicketEvent = {
      id: eventId,
      ticketId: ticket.id,
      actorType: "merchant",
      actorId: auth.userId,
      type: visibility === "public" ? "public_reply_added" : "private_note_added",
      before: { status: ticket.status },
      after: { status: updated.status, visibility, commentId },
      createdAt: now,
    };
    const job: TicketNotificationJob | null = visibility === "public"
      ? {
          id: `${ticket.id}:${eventId}:merchant-reply:customer`,
          ticketId: ticket.id,
          eventId,
          recipientType: "customer",
          template: "merchant-public-reply",
          recipient: ticket.requesterEmail,
          status: "queued",
          attempts: 0,
          createdAt: now,
          commentId,
          commentCreatedAt: now,
        }
      : null;
    try {
      await deps.tickets.addComment(updated, comment, audit, job, expectedVersion);
    } catch (cause) {
      if ((cause as { code?: string }).code === "CONCURRENT_TICKET_UPDATE") {
        return json(409, { error: "Ticket changed. Refresh and try again." });
      }
      throw cause;
    }
    console.log(JSON.stringify({
      event: visibility === "public" ? "ticket.first_response_or_reply" : "ticket.private_note",
      ticketId: ticket.id,
      actorId: auth.userId,
      firstResponseMs: visibility === "public" && ticket.firstRespondedAt === null ? now - ticket.createdAt : undefined,
    }));
    return json(201, { ticket: ticketView(updated), comment });
  }

  const retryMatch = TICKET_RETRY_PATH.exec(path);
  if (method === "POST" && retryMatch) {
    const ticket = await merchantTicket(deps, auth.shop, retryMatch[1]!);
    if (!ticket) return json(404, { error: "Ticket not found" });
    const timeline = await deps.tickets.loadTimeline(ticket.id);
    const jobId = decodeURIComponent(retryMatch[2]!);
    const job = timeline.notificationJobs.find((item) => item.id === jobId);
    if (!job) return json(404, { error: "Notification not found" });
    if (job.status !== "failed") return json(422, { error: "Only failed notifications can be retried" });
    try {
      await deps.tickets.retryNotification(job);
    } catch (cause) {
      if ((cause as { name?: string }).name === "ConditionalCheckFailedException") {
        return json(409, { error: "Notification changed. Refresh and try again." });
      }
      throw cause;
    }
    return json(202, { status: "queued" });
  }

  const ticketMatch = TICKET_ITEM_PATH.exec(path);
  if (ticketMatch && method === "GET") {
    const ticket = await merchantTicket(deps, auth.shop, ticketMatch[1]!);
    if (!ticket) return json(404, { error: "Ticket not found" });
    const timeline = await deps.tickets.loadTimeline(ticket.id);
    return json(200, { ticket: ticketView(ticket), ...timeline });
  }

  if (ticketMatch && method === "PATCH") {
    const ticket = await merchantTicket(deps, auth.shop, ticketMatch[1]!);
    if (!ticket) return json(404, { error: "Ticket not found" });
    const body = readJson(event);
    if (!body) return json(400, { error: "Body is not valid JSON" });
    const expectedVersion = body["expectedVersion"];
    if (typeof expectedVersion !== "number") return json(400, { error: "expectedVersion is required" });
    const fields = ["status", "priority", "assigneeUserId"].filter((key) => key in body);
    if (fields.length !== 1) return json(422, { error: "Change one ticket field at a time" });
    const now = Date.now();
    let updated: Ticket;
    let type: TicketEvent["type"];
    const field = fields[0]!;
    try {
      if (field === "status" && typeof body["status"] === "string" && isTicketStatus(body["status"])) {
        updated = transitionTicket(ticket, body["status"], now);
        type = "status_changed";
      } else if (field === "priority" && typeof body["priority"] === "string" && TICKET_PRIORITIES.includes(body["priority"] as TicketPriority)) {
        updated = updateTicketPriority(ticket, body["priority"] as TicketPriority, now);
        type = "priority_changed";
      } else if (field === "assigneeUserId" && (typeof body["assigneeUserId"] === "string" || body["assigneeUserId"] === null)) {
        updated = assignTicket(ticket, body["assigneeUserId"], now);
        type = "assigned";
      } else {
        return json(422, { error: "Invalid ticket update" });
      }
    } catch (cause) {
      return json(422, { error: (cause as Error).message });
    }
    const audit: TicketEvent = {
      id: TicketEventId(randomUUID()),
      ticketId: ticket.id,
      actorType: "merchant",
      actorId: auth.userId,
      type,
      before: { [field]: ticket[field as keyof Ticket] },
      after: { [field]: updated[field as keyof Ticket] },
      createdAt: now,
    };
    try {
      await deps.tickets.save(updated, audit, expectedVersion);
    } catch (cause) {
      if ((cause as { code?: string }).code === "CONCURRENT_TICKET_UPDATE") {
        return json(409, { error: "Ticket changed. Refresh and try again." });
      }
      throw cause;
    }
    console.log(JSON.stringify({
      event: "ticket.updated",
      ticketId: ticket.id,
      actorId: auth.userId,
      field,
      status: updated.status,
      resolutionMs: updated.status === "solved" ? now - ticket.createdAt : undefined,
    }));
    return json(200, { ticket: ticketView(updated) });
  }

  if (method === "GET" && UPLOADS_PATH.test(path)) {
    const documents = await deps.state.listUploadedDocuments();
    return json(200, { documents });
  }

  if (method === "POST" && UPLOADS_PATH.test(path)) {
    const purpose = readPurpose(event);
    if (!purpose) return json(400, { error: "purpose is required" });

    const slot = await deps.createUploadSlot(purpose);
    // Written the instant the slot is minted, before the browser has uploaded
    // a single byte — the admin page has something honest to show
    // ("Processing…") from the moment it makes this request, rather than a
    // blank row until the PUT completes and ingestion picks it up. title
    // comes from the slot, not a fresh read of `purpose` — it is the exact,
    // trimmed string createUploadSlot already committed to as this
    // document's identity.
    await deps.state.recordUploadStarted({
      documentId: slot.documentId,
      s3Key: slot.s3Key,
      title: slot.title,
    });

    return json(200, { documentId: slot.documentId, uploadUrl: slot.uploadUrl });
  }

  const deleteMatch = UPLOAD_ITEM_PATH.exec(path);
  if (method === "DELETE" && deleteMatch) {
    const documentId = decodeURIComponent(deleteMatch[1]!);
    // S3 delete first: it is what actually removes the document from search
    // (via the ingestion Lambda's existing ObjectRemoved handling). Removing
    // the visible row second means a failure here still leaves the merchant
    // looking at a row for a document that is genuinely gone from the index —
    // confusing, but never the reverse (a row that disappears while the PDF
    // it names is still live and searchable).
    await deps.deleteUploadObject(documentId);
    await deps.state.deleteUploadRecord(documentId);
    return { statusCode: 204, headers: {}, body: "" };
  }

  return json(404, { error: "Not found" });
}

function json(statusCode: number, body: unknown): AdminResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Function URL events lowercase every header name, but this is cheap insurance
 * against a test fixture — or a future runtime — that doesn't.
 */
function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function readPurpose(event: AdminEvent): string | null {
  if (!event.body) return null;

  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const purpose = (parsed as Record<string, unknown>)["purpose"];
  return typeof purpose === "string" && purpose.trim().length > 0 ? purpose : null;
}

function readJson(event: AdminEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function queryParams(event: AdminEvent): URLSearchParams {
  if (event.rawQueryString) return new URLSearchParams(event.rawQueryString);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

function isTicketStatus(value: string): value is TicketStatus {
  return TICKET_STATUSES.includes(value as TicketStatus);
}

async function merchantTicket(deps: AdminDeps, shop: string, rawId: string): Promise<Ticket | null> {
  const ticket = await deps.tickets.load(TicketId(decodeURIComponent(rawId)));
  return ticket?.shop === shop ? ticket : null;
}

function ticketView(ticket: Ticket) {
  return {
    id: ticket.id,
    sessionId: ticket.sessionId,
    requesterEmail: ticket.requesterEmail,
    requesterName: ticket.requesterName,
    subject: ticket.subject,
    reason: ticket.reason,
    summary: ticket.summary,
    addedDetail: ticket.addedDetail,
    transcript: ticket.transcript,
    status: ticket.status,
    priority: ticket.priority,
    assigneeUserId: ticket.assigneeUserId,
    followUpToTicketId: ticket.followUpToTicketId,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    firstRespondedAt: ticket.firstRespondedAt,
    solvedAt: ticket.solvedAt,
    closedAt: ticket.closedAt,
    version: ticket.version,
  };
}
