/**
 * SSE frame parsing.
 *
 * Separate from useChat.ts because it touches no React and no DOM beyond the
 * streams API — which means it can be tested directly, without a JSX runtime or
 * a rendered component. The bug class below is subtle enough to deserve that.
 */

import type { ProductRef } from "./types.js";

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

type ServerEvent =
  | { type: "token"; text: string }
  | { type: "tool_started"; name: string }
  | { type: "done"; products?: readonly ProductRef[] }
  | { type: "refused"; reason: string };

/**
 * Parse an SSE byte stream into events.
 *
 * ⚠️ A CHUNK IS NOT A FRAME. `ReadableStream` hands over arbitrary byte slices —
 * one read can contain three frames, or half of one, and a multi-byte character
 * can be split across two reads. Parsing each chunk independently produces
 * mangled output that looks like a model problem and is not.
 *
 * `TextDecoder` with `{ stream: true }` handles the split characters; the
 * `buffer` below handles the split frames.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Split on it and keep the tail,
      // which may be an incomplete frame awaiting more bytes.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;

        try {
          yield JSON.parse(line.slice(5).trim()) as ServerEvent;
        } catch {
          // A malformed frame must not kill the stream. The rest of the answer
          // is still worth delivering.
        }
      }
    }
  } finally {
    // Releasing the lock lets the abort actually tear the connection down.
    reader.releaseLock();
  }
}
