/**
 * Server-Sent Events framing.
 *
 * WHY SSE AND NOT WEBSOCKETS: the traffic is one-directional (server pushes
 * tokens), SSE is plain HTTP so it traverses CloudFront and corporate proxies
 * without special handling, and it reconnects on its own. WebSockets would mean
 * API Gateway's WebSocket API, connection state in DynamoDB, and a lifecycle to
 * manage — all to solve a problem we don't have.
 *
 * WHY STREAMING AT ALL: a full answer takes 3-5 seconds to generate. Sent whole,
 * the customer watches a spinner. Streamed, the first word lands in under a
 * second and arrives at reading speed. Same total time, completely different
 * experience — and measurably lower abandonment.
 */

import type { ChatEvent } from "@nailzify/core";

/** Minimal sink so framing is testable without a Lambda response stream. */
export interface ByteSink {
  write(chunk: string): void;
  end(): void;
}

export interface SseWriter {
  send(event: ChatEvent): void;
  /** Comment frame. Keeps intermediaries from closing an idle connection. */
  heartbeat(): void;
  fail(message: string): void;
  close(): void;
}

export function createSseWriter(sink: ByteSink): SseWriter {
  let closed = false;

  const frame = (payload: unknown): void => {
    if (closed) return;
    // A frame is `data: <json>` terminated by a BLANK line. The blank line is
    // the delimiter — omit it and the client buffers forever waiting for one.
    sink.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  return {
    send: frame,

    // Comment frames (`:` prefix) are ignored by EventSource-style parsers but
    // count as traffic, so proxies keep the connection open.
    heartbeat: () => {
      if (!closed) sink.write(": ping\n\n");
    },

    fail: (message) => {
      frame({ type: "error", message });
    },

    close: () => {
      if (closed) return;
      closed = true;
      sink.end();
    },
  };
}

/**
 * Pump chat events into an SSE stream.
 *
 * Errors thrown mid-stream are converted into a terminal `error` frame. By the
 * time generation starts the HTTP status is already sent, so there is no way to
 * turn a failure into a 500 — the only honest option is to tell the client in
 * band. Letting the promise reject would leave the connection hanging until the
 * client times out, which reads as a frozen chat.
 */
export async function pumpToSse(
  events: AsyncIterable<ChatEvent>,
  writer: SseWriter,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const event of events) writer.send(event);
  } catch (error) {
    onError?.(error);
    writer.fail("Something went wrong on our end. Please try again.");
  } finally {
    writer.close();
  }
}
