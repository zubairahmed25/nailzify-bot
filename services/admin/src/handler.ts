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

export interface AdminEvent {
  readonly rawPath?: string;
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
  // Deliberately vague in the response, same as the App Proxy's 401 — the real
  // reason belongs in logs, not handed to whoever is knocking on the endpoint.
  if (!auth.ok) return json(401, { error: "Unauthorized" });

  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "";

  if (method === "GET" && UPLOADS_PATH.test(path)) {
    const documents = await deps.state.listUploadedDocuments();
    return json(200, { documents });
  }

  if (method === "POST" && UPLOADS_PATH.test(path)) {
    const filename = readFilename(event);
    if (!filename) return json(400, { error: "filename is required" });

    const slot = await deps.createUploadSlot(filename);
    // Written the instant the slot is minted, before the browser has uploaded
    // a single byte — the admin page has something honest to show
    // ("Processing…") from the moment it makes this request, rather than a
    // blank row until the PUT completes and ingestion picks it up.
    await deps.state.recordUploadStarted({ documentId: slot.documentId, s3Key: slot.s3Key });

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

function readFilename(event: AdminEvent): string | null {
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
  const filename = (parsed as Record<string, unknown>)["filename"];
  return typeof filename === "string" && filename.trim().length > 0 ? filename : null;
}
