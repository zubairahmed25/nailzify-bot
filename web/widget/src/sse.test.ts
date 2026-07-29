import { describe, expect, it } from "vitest";
import { readSse } from "./sse.js";

/** Build a ReadableStream that emits exactly these byte slices, in order. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Same, but split at an arbitrary BYTE index — how a network really behaves. */
function streamOfBytes(text: string, splitAt: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of readSse(stream, new AbortController().signal)) events.push(event);
  return events;
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

// ---------------------------------------------------------------------------
// A CHUNK IS NOT A FRAME. This is the bug class these tests exist for: parsing
// each chunk independently produces mangled text that reads like a model
// problem and is not.
// ---------------------------------------------------------------------------

describe("frame reassembly", () => {
  it("reads several frames arriving in one chunk", async () => {
    const events = await collect(
      streamOf([frame({ type: "token", text: "a" }) + frame({ type: "token", text: "b" })]),
    );

    expect(events.map((e) => (e as { text: string }).text)).toEqual(["a", "b"]);
  });

  it("reassembles a frame split across two chunks", async () => {
    const whole = frame({ type: "token", text: "hello" });
    const events = await collect(streamOf([whole.slice(0, 12), whole.slice(12)]));

    expect(events).toEqual([{ type: "token", text: "hello" }]);
  });

  it("reassembles a frame split one byte at a time", async () => {
    const whole = frame({ type: "token", text: "drip" });
    const events = await collect(streamOf([...whole]));

    expect(events).toEqual([{ type: "token", text: "drip" }]);
  });

  it("handles a multi-byte character split across chunks", async () => {
    // "£" is two UTF-8 bytes and a price can start with one. Decoding each chunk
    // independently yields a replacement character mid-price — a customer sees
    // "�13.99" and reports it as the bot being broken.
    const whole = frame({ type: "token", text: "£13.99 — lovely" });
    const bytes = new TextEncoder().encode(whole);

    // Split inside the em dash (3 bytes), not on a character boundary.
    const emDashAt = bytes.indexOf(0xe2);
    const events = await collect(streamOfBytes(whole, emDashAt + 1));

    expect(events).toEqual([{ type: "token", text: "£13.99 — lovely" }]);
  });

  it("survives a malformed frame without losing the rest", async () => {
    // A truncated or corrupt frame must not kill the stream — the remainder of
    // the answer is still worth delivering.
    const events = await collect(
      streamOf([
        "data: {not json}\n\n" + frame({ type: "token", text: "after" }),
      ]),
    );

    expect(events).toEqual([{ type: "token", text: "after" }]);
  });

  it("ignores heartbeat comment frames", async () => {
    // `: ping` keeps proxies from closing an idle connection and carries no data.
    const events = await collect(streamOf([": ping\n\n" + frame({ type: "token", text: "x" })]));

    expect(events).toEqual([{ type: "token", text: "x" }]);
  });

  it("drops a trailing partial frame rather than emitting half an event", async () => {
    const events = await collect(
      streamOf([frame({ type: "token", text: "done" }) + 'data: {"type":"tok']),
    );

    expect(events).toEqual([{ type: "token", text: "done" }]);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const e of readSse(streamOf([frame({ type: "token", text: "x" })]), controller.signal)) {
      events.push(e);
    }

    expect(events).toEqual([]);
  });
});
