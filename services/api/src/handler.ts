/**
 * Chat Lambda — streaming Function URL entry point.
 *
 * ============================================================================
 * WHY A FUNCTION URL AND NOT API GATEWAY
 * ============================================================================
 *
 * API Gateway CANNOT stream a response body — it buffers. Put it in front of
 * this and the customer stares at a spinner for four seconds and then the whole
 * answer appears at once. A Function URL in RESPONSE_STREAM mode emits SSE and
 * the first token lands in ~800ms.
 *
 * Perceived latency drops roughly 4x, and perceived latency is the only latency
 * a customer experiences. This is the single easiest thing to get silently wrong
 * in this architecture (docs/02-aws-services.md §2.2).
 *
 * The URL uses `authType: AWS_IAM` with CloudFront Origin Access Control, so it
 * is not publicly callable — otherwise anyone discovering it bypasses WAF and
 * bills Bedrock directly (docs/09-deployment.md §9.5).
 *
 * ORDER OF OPERATIONS IS DELIBERATE: cheapest rejection first. Signature, then
 * schema, then session budget, and only then does anything cost money.
 */

import type { Container } from "./composition-root.js";
import { createSseWriter, pumpToSse, type ByteSink } from "./http/sse.js";
import { validateChatRequest } from "./http/validate.js";
import { verifyAppProxyRequest } from "./security/verify-app-proxy.js";
import { CustomerOrderServiceError } from "./customer-orders/service.js";
import {
  classifyOrderIntent,
  CustomerId,
  MessageId,
  SessionId,
  type QuickActionIntent,
} from "@nailzify/core";

/**
 * Older Shopify theme assets sent only the visible pill label. Keep those
 * exact labels deterministic while cached storefront bundles age out.
 */
const LEGACY_QUICK_ACTION_LABELS = new Map<string, QuickActionIntent>([
  ["Help me choose", "help_choose"],
  ["Current promos", "current_promos"],
  ["Wear & care", "wear_care"],
  ["My order", "my_order"],
  ["Best sellers", "best_sellers"],
]);

/**
 * The Lambda runtime injects `awslambda` as a global — it is not importable.
 * Declared here so TypeScript knows about it without pulling in a shim.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace awslambda {
    const HttpResponseStream: {
      from(stream: ResponseStream, metadata: ResponseMetadata): ResponseStream;
    };
  }
}

export interface ResponseStream extends ByteSink {
  write(chunk: string): void;
  end(): void;
}

interface ResponseMetadata {
  statusCode: number;
  headers: Record<string, string>;
}

export interface FunctionUrlEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly http?: {
      readonly method?: string;
      readonly path?: string;
      readonly sourceIp?: string;
    };
  };
}

/**
 * The request pipeline.
 *
 * Deliberately NOT wrapped in `awslambda.streamifyResponse` here. That call
 * executes at MODULE LOAD, so a module doing it cannot be imported outside the
 * Lambda runtime — not by tests, not by bundler analysis. The Lambda entry point
 * lives in lambda.ts and is the only file that touches the runtime global at
 * load time.
 */
export async function handleRequest(
  event: FunctionUrlEvent,
  responseStream: ResponseStream,
  resolveContainer: () => Promise<Container>,
): Promise<void> {
  const reject = (statusCode: number, message: string): void => {
    // A rejection is a normal HTTP response, not a stream — the status code is
    // still ours to set because nothing has been written yet.
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "content-type": "application/json" },
    });
    stream.write(JSON.stringify({ error: message }));
    stream.end();
  };

  const json = (statusCode: number, value: unknown): void => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
    stream.write(JSON.stringify(value));
    stream.end();
  };

  const redirect = (location: string): void => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 302,
      headers: {
        location,
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
    // Lambda response streams do not flush status and headers when the stream
    // ends without a body. Write a small fallback message so CloudFront receives
    // the 302 instead of exposing an empty application/octet-stream download.
    stream.write("Redirecting...");
    stream.end();
  };

  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const method = event.requestContext?.http?.method;
  const isOrderCallback = path.endsWith("/customer-orders/auth/callback");
  if (method !== "POST" && !(method === "GET" && isOrderCallback)) {
    return reject(405, "Method not allowed");
  }

  let resolved: Container;
  try {
    resolved = await resolveContainer();
  } catch {
    // Never leak configuration detail to a caller.
    return reject(503, "Service is not configured");
  }

  const query = parseQuery(event);

  if (isOrderCallback) {
    if (!resolved.customerOrders) return reject(404, "Order lookup is not available");
    const code = firstQueryValue(query["code"]);
    const callbackError = firstQueryValue(query["error"]);
    try {
      const location = await resolved.customerOrders.completeAuthentication({
        state: firstQueryValue(query["state"]) ?? "",
        ...(code ? { code } : {}),
        ...(callbackError ? { error: callbackError } : {}),
      });
      return redirect(location);
    } catch {
      return reject(503, "Secure sign in is temporarily unavailable");
    }
  }

  // ---- 1. Signature. Cheapest meaningful rejection, and the security gate. ---
  const verification = verifyAppProxyRequest(query, resolved.proxySecret);
  if (!verification.ok) {
    // Deliberately vague. Telling an attacker *why* verification failed helps
    // them iterate; the real reason goes to logs, not the response.
    return reject(401, "Unauthorized");
  }

  if (path.includes("/customer-orders/")) {
    if (!resolved.customerOrders) return reject(404, "Order lookup is not available");
    let input: Record<string, unknown>;
    try {
      input = parseJsonObject(event);
    } catch {
      return reject(400, "Body is not valid JSON");
    }
    try {
      if (path.endsWith("/customer-orders/auth/start")) {
        const result = await resolved.customerOrders.beginAuthentication({
          shop: verification.shop,
          sessionId: stringField(input, "sessionId"),
          returnUrl: stringField(input, "returnUrl"),
          ...(event.requestContext?.http?.sourceIp
            ? { sourceAddress: event.requestContext.http.sourceIp }
            : {}),
        });
        return json(200, result);
      }
      if (path.endsWith("/customer-orders/recent")) {
        const orders = await resolved.customerOrders.listRecent({
          shop: verification.shop,
          sessionId: stringField(input, "sessionId"),
          customerId: verification.customerId,
        });
        return json(200, { orders });
      }
      if (path.endsWith("/customer-orders/detail")) {
        const order = await resolved.customerOrders.getDetail({
          shop: verification.shop,
          sessionId: stringField(input, "sessionId"),
          customerId: verification.customerId,
          orderId: stringField(input, "orderId"),
        });
        return json(200, { order });
      }
      return reject(404, "Not found");
    } catch (error) {
      if (error instanceof CustomerOrderServiceError) {
        return json(error.status, { error: error.message, code: error.code });
      }
      return reject(503, "Orders are temporarily unavailable");
    }
  }

  if (path.endsWith("/tickets")) {
    let input: Record<string, unknown>;
    try {
      input = parseJsonObject(event);
    } catch {
      return reject(400, "Body is not valid JSON");
    }

    let addedDetail = typeof input["addedDetail"] === "string" ? input["addedDetail"] : undefined;
    if (
      input["includeOrderContext"] === true &&
      typeof input["orderId"] === "string"
    ) {
      if (!resolved.customerOrders) return reject(409, "Order context is not available");
      try {
        const order = await resolved.customerOrders.getDetail({
          shop: verification.shop,
          sessionId: typeof input["sessionId"] === "string" ? input["sessionId"] : "",
          customerId: verification.customerId,
          orderId: input["orderId"],
        });
        const context = formatOrderTicketContext(order);
        addedDetail = addedDetail?.trim()
          ? `${context}\n\nCustomer note: ${addedDetail.trim()}`
          : context;
      } catch (error) {
        if (error instanceof CustomerOrderServiceError) {
          return json(error.status, { error: error.message, code: error.code });
        }
        return reject(503, "Order context is temporarily unavailable");
      }
    }

    const result = await resolved.createTicket({
      shop: verification.shop,
      sessionId: typeof input["sessionId"] === "string" ? input["sessionId"] : "",
      escalationId: typeof input["escalationId"] === "string" ? input["escalationId"] : "",
      email: typeof input["email"] === "string" ? input["email"] : "",
      ...(typeof input["name"] === "string" ? { name: input["name"] } : {}),
      ...(addedDetail !== undefined ? { addedDetail } : {}),
      includeTranscript: input["includeTranscript"] === true,
    });
    if (!result.ok) return reject(result.status, result.reason);
    console.log(JSON.stringify({
      event: "ticket.created",
      ticketId: result.ticket.id,
      shop: verification.shop,
      created: result.created,
      transcriptIncluded: result.ticket.transcript !== null,
    }));
    return json(result.created ? 201 : 200, {
      ticketId: result.ticket.id,
      status: result.ticket.status,
      createdAt: result.ticket.createdAt,
    });
  }

  // ---- 2. Schema. Still free. ----------------------------------------------
  const body = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  const validated = validateChatRequest(body);
  if (!validated.ok) return reject(400, validated.reason);

  // ---- 3. Stream. Past this point the status code is committed. -------------
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      // Chat responses are per-customer. Caching one would serve another
      // customer's answer — not hypothetical, just a misconfiguration.
      "x-accel-buffering": "no",
    },
  });

  const writer = createSseWriter(stream);

  const quickAction =
    validated.value.quickAction ?? LEGACY_QUICK_ACTION_LABELS.get(validated.value.message);

  if (
    resolved.customerOrders &&
    classifyOrderIntent(validated.value.message, quickAction) === "lookup"
  ) {
    writer.send({ type: "order_lookup" });
    writer.close();
    return;
  }

  const events = resolved.handleMessage({
    sessionId: SessionId(validated.value.sessionId),
    // Trusted because it arrived through a verified App Proxy signature, not
    // because the browser sent it. A browser-supplied customer id would be
    // worthless as an identity claim.
    customerId: verification.customerId ? CustomerId(verification.customerId) : null,
    messageId: MessageId(validated.value.messageId),
    text: validated.value.message,
    ...(quickAction ? { quickAction } : {}),
  });

  await pumpToSse(events, writer, (error) => {
    console.error(
      JSON.stringify({
        event: "chat.turn.failed",
        sessionId: validated.value.sessionId,
        message: (error as Error)?.message,
      }),
    );
  });
}

function parseJsonObject(event: FunctionUrlEvent): Record<string, unknown> {
  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  const parsed: unknown = JSON.parse(rawBody ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  return parsed as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new CustomerOrderServiceError("invalid_request", 400, `${key} is required.`);
  }
  return value;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatOrderTicketContext(order: {
  readonly name: string;
  readonly createdAt: string;
  readonly total: { readonly amount: string; readonly currencyCode: string };
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string;
  readonly lineItems: readonly { readonly name: string; readonly quantity: number }[];
  readonly tracking: readonly {
    readonly company: string | null;
    readonly number: string | null;
    readonly url: string | null;
  }[];
}): string {
  const items = order.lineItems.map((item) => `${item.name} x${item.quantity}`).join(", ") || "None listed";
  const tracking = order.tracking.map((item) =>
    [item.company, item.number, item.url].filter(Boolean).join(" | ")
  ).filter(Boolean).join(", ") || "Not available";
  return [
    "Customer agreed to attach selected order context:",
    `Order: ${order.name}`,
    `Placed: ${order.createdAt}`,
    `Items: ${items}`,
    `Total: ${order.total.amount} ${order.total.currencyCode}`,
    `Payment: ${order.financialStatus ?? "Not available"}`,
    `Fulfillment: ${order.fulfillmentStatus}`,
    `Tracking: ${tracking}`,
  ].join("\n");
}

/**
 * Function URL events expose the query string two ways.
 *
 * `queryStringParameters` is pre-parsed but collapses repeated keys, which would
 * corrupt the signature calculation. Prefer the raw string and parse it
 * ourselves so repeated params survive.
 */
function parseQuery(event: FunctionUrlEvent): Record<string, string | string[]> {
  if (typeof event.rawQueryString === "string" && event.rawQueryString.length > 0) {
    const params = new URLSearchParams(event.rawQueryString);
    const out: Record<string, string | string[]> = {};
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      out[key] = values.length > 1 ? values : values[0]!;
    }
    return out;
  }

  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
