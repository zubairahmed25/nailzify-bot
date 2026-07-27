import { describe, expect, it, vi } from "vitest";
import { LlmThrottled, LlmUnavailable, MessageId, type Message } from "@nailzify/core";
import type { LlmStreamEvent, LlmUsage } from "@nailzify/core";
import { createBedrockLlmClient, FALLBACK_MODELS } from "./llm-client.js";

// ---------------------------------------------------------------------------
// Fake Bedrock client. No network, no credentials — the whole point of the port.
// ---------------------------------------------------------------------------

const usage = (over: Record<string, unknown> = {}) => ({
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  ...over,
});

/** Loose shapes so the fake can assert on what the adapter actually sent. */
type Block = Record<string, unknown>;
interface SentMessage {
  readonly role: string;
  readonly content: string | Block[];
}
interface SentParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string | Block[];
  readonly tools?: readonly Block[];
  readonly messages: readonly SentMessage[];
}

/** Narrow a sent message's content to blocks. Throws loudly if it was a string. */
const blocks = (message: SentMessage | undefined): Block[] => {
  if (!message || typeof message.content === "string") {
    throw new Error("expected block content, received a string");
  }
  return message.content;
};

function fakeClient(opts: {
  create?: unknown;
  streamEvents?: unknown[];
  finalMessage?: unknown;
  throwOnCreate?: unknown;
  throwOnStream?: unknown;
}) {
  const createSpy = vi.fn(async (_params: SentParams) => {
    if (opts.throwOnCreate) throw opts.throwOnCreate;
    return opts.create ?? { content: [], stop_reason: "end_turn", usage: usage() };
  });

  const streamSpy = vi.fn((_params: SentParams) => {
    if (opts.throwOnStream) throw opts.throwOnStream;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of opts.streamEvents ?? []) yield event;
      },
      finalMessage: async () =>
        opts.finalMessage ?? { content: [], stop_reason: "end_turn", usage: usage() },
    };
  });

  const sent = (): SentParams => {
    const call = createSpy.mock.calls[0];
    if (!call) throw new Error("create was never called");
    return call[0];
  };

  return {
    client: { messages: { create: createSpy, stream: streamSpy } },
    createSpy,
    streamSpy,
    sent,
  };
}

const make = (opts: Parameters<typeof fakeClient>[0], onUsage?: (u: LlmUsage & { model: string }) => void) => {
  const fake = fakeClient(opts);
  return {
    ...fake,
    llm: createBedrockLlmClient({
      region: "us-east-1",
      models: FALLBACK_MODELS,
      client: fake.client as never,
      ...(onUsage ? { onUsage } : {}),
    }),
  };
};

const userMsg = (content: string): Message => ({
  id: MessageId("u1"),
  role: "user",
  content,
  createdAt: 0,
});

const baseRequest = {
  model: "chat" as const,
  system: "You are the Nailzify concierge.",
  maxTokens: 1024,
  messages: [userMsg("hi")],
};

// ---------------------------------------------------------------------------

describe("model routing", () => {
  it("resolves a role to a concrete inference-profile id", async () => {
    // The domain asks for "the chat model", never for a Bedrock id — so model
    // routing stays a config change rather than a code change.
    const { llm, sent } = make({});

    await llm.complete(baseRequest);

    expect(sent().model).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("routes the fast role to a different model", async () => {
    const { llm, sent } = make({});

    await llm.complete({ ...baseRequest, model: "fast" });

    expect(sent().model).toContain("haiku");
  });

  it("uses an inference-profile prefix, not a bare model id", async () => {
    // A bare `anthropic.claude-sonnet-4-6` returns ValidationException — current
    // Claude models require a cross-region profile, and the error does not say so.
    for (const id of Object.values(FALLBACK_MODELS)) {
      expect(id).toMatch(/^(us|global)\./);
    }
  });
});

describe("prompt caching", () => {
  it("marks the system prompt as a cacheable prefix when asked", async () => {
    const { llm, sent } = make({});

    await llm.complete({ ...baseRequest, cacheSystemPrompt: true });

    const system = sent().system;
    expect(Array.isArray(system)).toBe(true);
    expect((system as Block[])[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("sends a plain string when caching is off", async () => {
    // Bedrock has NO automatic top-level caching — the annotation is the only
    // mechanism, so its absence must be unambiguous.
    const { llm, sent } = make({});

    await llm.complete(baseRequest);

    expect(typeof sent().system).toBe("string");
  });

  it("reports cache reads so silent cache failure is observable", async () => {
    // Caching fails silently: one changed byte in the prefix and you pay full
    // price forever with no error. This callback is the only signal.
    const seen: (LlmUsage & { model: string })[] = [];
    const { llm } = make(
      {
        create: {
          content: [],
          stop_reason: "end_turn",
          usage: usage({ cache_read_input_tokens: 2890 }),
        },
      },
      (u) => seen.push(u),
    );

    await llm.complete(baseRequest);

    expect(seen[0]!.cacheReadInputTokens).toBe(2890);
    expect(seen[0]!.model).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("reports 0 rather than undefined when nothing was cached", async () => {
    const seen: LlmUsage[] = [];
    const { llm } = make(
      { create: { content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } } },
      (u) => seen.push(u),
    );

    await llm.complete(baseRequest);

    // Dashboards must distinguish "cache miss" from "field absent".
    expect(seen[0]!.cacheReadInputTokens).toBe(0);
  });
});

describe("tool loop message conversion", () => {
  it("rebuilds an assistant turn with its tool_use blocks", async () => {
    const assistant: Message = {
      id: MessageId("a1"),
      role: "assistant",
      content: "Let me look that up.",
      createdAt: 0,
      toolCalls: [{ id: "toolu_1", name: "search_products", input: { query: "almond" } }],
    };
    const { llm, sent } = make({});

    await llm.complete({ ...baseRequest, messages: [userMsg("hi"), assistant] });

    const content = blocks(sent().messages[1]);
    expect(content[0]).toEqual({ type: "text", text: "Let me look that up." });
    expect(content[1]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "search_products" });
  });

  it("omits an empty text block from an assistant turn", async () => {
    // A turn that only calls tools has no text. Sending an empty text block is
    // rejected by the API.
    const assistant: Message = {
      id: MessageId("a1"),
      role: "assistant",
      content: "",
      createdAt: 0,
      toolCalls: [{ id: "toolu_1", name: "search_products", input: {} }],
    };
    const { llm, sent } = make({});

    await llm.complete({ ...baseRequest, messages: [userMsg("hi"), assistant] });

    const content = blocks(sent().messages[1]);
    expect(content).toHaveLength(1);
    expect(content[0]!["type"]).toBe("tool_use");
  });

  it("puts ALL tool results in a single user message", async () => {
    // ⚠️ Splitting results across messages silently teaches the model to stop
    // making parallel tool calls — a regression with no error to catch.
    const results: Message = {
      id: MessageId("u2"),
      role: "user",
      content: "",
      createdAt: 0,
      toolResults: [
        { toolCallId: "toolu_1", content: "[]", isError: false, latencyMs: 10 },
        { toolCallId: "toolu_2", content: "[]", isError: false, latencyMs: 12 },
      ],
    };
    const { llm, sent } = make({});

    await llm.complete({ ...baseRequest, messages: [results] });

    const messages = sent().messages;
    expect(messages).toHaveLength(1);
    const content = blocks(messages[0]);
    expect(content).toHaveLength(2);
    expect(content.every((b) => b["type"] === "tool_result")).toBe(true);
  });

  it("flags a failed tool as is_error rather than throwing", async () => {
    // A failed tool is information the model needs so it can apologise, not an
    // exception that should abort the turn.
    const results: Message = {
      id: MessageId("u2"),
      role: "user",
      content: "",
      createdAt: 0,
      toolResults: [
        { toolCallId: "toolu_1", content: "Shopify unreachable", isError: true, latencyMs: 5000 },
      ],
    };
    const { llm, sent } = make({});

    await llm.complete({ ...baseRequest, messages: [results] });

    expect(blocks(sent().messages[0])[0]!["is_error"]).toBe(true);
  });

  it("sends a plain user turn as a string", async () => {
    const { llm, sent } = make({});

    await llm.complete(baseRequest);

    expect(sent().messages[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("response parsing", () => {
  it("joins text blocks and extracts tool calls", async () => {
    const { llm } = make({
      create: {
        content: [
          { type: "text", text: "Looking now. " },
          { type: "tool_use", id: "toolu_1", name: "search_products", input: { query: "almond" } },
        ],
        stop_reason: "tool_use",
        usage: usage(),
      },
    });

    const response = await llm.complete(baseRequest);

    expect(response.text).toBe("Looking now. ");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls[0]).toMatchObject({ name: "search_products" });
  });

  it("normalises unknown stop reasons to end_turn", async () => {
    const { llm } = make({
      create: { content: [], stop_reason: "stop_sequence", usage: usage() },
    });

    expect((await llm.complete(baseRequest)).stopReason).toBe("end_turn");
  });

  it("surfaces a refusal distinctly", async () => {
    const { llm } = make({ create: { content: [], stop_reason: "refusal", usage: usage() } });

    expect((await llm.complete(baseRequest)).stopReason).toBe("refusal");
  });
});

describe("streaming", () => {
  async function collect(events: LlmStreamEvent[] | AsyncIterable<LlmStreamEvent>) {
    const out: LlmStreamEvent[] = [];
    for await (const event of events as AsyncIterable<LlmStreamEvent>) out.push(event);
    return out;
  }

  it("yields text deltas as they arrive", async () => {
    const { llm } = make({
      streamEvents: [
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Our " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sizing " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "guide..." } },
      ],
    });

    const events = await collect(llm.stream(baseRequest));
    const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");

    expect(text).toBe("Our sizing guide...");
  });

  it("accumulates tool JSON across partial deltas", async () => {
    // THE SUBTLE ONE. Tool inputs stream as `input_json_delta` fragments. A
    // fragment is not valid JSON on its own, so parsing can only happen when
    // the block closes. Parsing per-delta works in a demo and fails in prod.
    const { llm } = make({
      streamEvents: [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "search_products" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"qu' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ery":"al' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'mond"}' } },
        { type: "content_block_stop", index: 0 },
      ],
      finalMessage: { content: [], stop_reason: "tool_use", usage: usage() },
    });

    const events = await collect(llm.stream(baseRequest));
    const toolEvent = events.find((e) => e.type === "tool_use");

    expect(toolEvent).toMatchObject({ id: "toolu_1", name: "search_products" });
    expect(toolEvent && toolEvent.type === "tool_use" ? toolEvent.input : null).toEqual({
      query: "almond",
    });
  });

  it("handles a tool call with no arguments", async () => {
    // An empty-argument call streams as "" rather than "{}".
    const { llm } = make({
      streamEvents: [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "escalate_to_human" },
        },
        { type: "content_block_stop", index: 0 },
      ],
      finalMessage: { content: [], stop_reason: "tool_use", usage: usage() },
    });

    const events = await collect(llm.stream(baseRequest));
    const toolEvent = events.find((e) => e.type === "tool_use");

    expect(toolEvent && toolEvent.type === "tool_use" ? toolEvent.input : null).toEqual({});
  });

  it("survives malformed tool JSON rather than killing the turn", async () => {
    const { llm } = make({
      streamEvents: [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "search_products" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{broken" } },
        { type: "content_block_stop", index: 0 },
      ],
      finalMessage: { content: [], stop_reason: "tool_use", usage: usage() },
    });

    const events = await collect(llm.stream(baseRequest));
    const toolEvent = events.find((e) => e.type === "tool_use");

    expect(toolEvent && toolEvent.type === "tool_use" ? toolEvent.input : null).toEqual({});
  });

  it("emits a terminating done event with usage", async () => {
    const { llm } = make({
      streamEvents: [],
      finalMessage: {
        content: [],
        stop_reason: "end_turn",
        usage: usage({ cache_read_input_tokens: 500 }),
      },
    });

    const events = await collect(llm.stream(baseRequest));
    const done = events.at(-1);

    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.stopReason).toBe("end_turn");
      expect(done.usage.cacheReadInputTokens).toBe(500);
    }
  });

  it("tracks two concurrent tool blocks by index", async () => {
    // Parallel tool calls interleave their deltas. Keying on block index is
    // what keeps the two JSON payloads from being spliced together.
    const { llm } = make({
      streamEvents: [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "a" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "b" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"y":2}' } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_stop", index: 1 },
      ],
      finalMessage: { content: [], stop_reason: "tool_use", usage: usage() },
    });

    const tools = (await collect(llm.stream(baseRequest))).filter((e) => e.type === "tool_use");

    expect(tools).toHaveLength(2);
    expect(tools[0] && tools[0].type === "tool_use" ? tools[0].input : null).toEqual({ x: 1 });
    expect(tools[1] && tools[1].type === "tool_use" ? tools[1].input : null).toEqual({ y: 2 });
  });
});

describe("error translation", () => {
  it("marks throttling retryable", async () => {
    const { llm } = make({ throwOnCreate: Object.assign(new Error("slow down"), { status: 429 }) });

    await expect(llm.complete(baseRequest)).rejects.toBeInstanceOf(LlmThrottled);
  });

  it("treats overloaded (529) as retryable", async () => {
    const { llm } = make({ throwOnCreate: Object.assign(new Error("overloaded"), { status: 529 }) });

    await expect(llm.complete(baseRequest)).rejects.toBeInstanceOf(LlmThrottled);
  });

  it("surfaces an access failure with its message intact", async () => {
    // 403/404 usually means model access is not granted or a profile is
    // required. Both are config, not transient — the raw text is the diagnosis.
    const { llm } = make({
      throwOnCreate: Object.assign(
        new Error("Model use case details have not been submitted for this account."),
        { status: 404 },
      ),
    });

    await expect(llm.complete(baseRequest)).rejects.toThrow(/use case details/);
    await expect(llm.complete(baseRequest)).rejects.toBeInstanceOf(LlmUnavailable);
  });
});
