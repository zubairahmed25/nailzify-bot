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
import { CustomerId, MessageId, SessionId } from "@nailzify/core";

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
  readonly rawQueryString?: string;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
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

  if (event.requestContext?.http?.method !== "POST") {
    return reject(405, "Method not allowed");
  }

  let resolved: Container;
  try {
    resolved = await resolveContainer();
  } catch {
    // Never leak configuration detail to a caller.
    return reject(503, "Service is not configured");
  }

  // ---- 1. Signature. Cheapest meaningful rejection, and the security gate. ---
  const query = parseQuery(event);
  const verification = verifyAppProxyRequest(query, resolved.proxySecret);
  if (!verification.ok) {
    // Deliberately vague. Telling an attacker *why* verification failed helps
    // them iterate; the real reason goes to logs, not the response.
    return reject(401, "Unauthorized");
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

  const events = resolved.handleMessage({
    sessionId: SessionId(validated.value.sessionId),
    // Trusted because it arrived through a verified App Proxy signature, not
    // because the browser sent it. A browser-supplied customer id would be
    // worthless as an identity claim.
    customerId: verification.customerId ? CustomerId(verification.customerId) : null,
    messageId: MessageId(validated.value.messageId),
    text: validated.value.message,
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
