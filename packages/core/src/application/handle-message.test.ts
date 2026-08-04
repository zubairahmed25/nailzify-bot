import { describe, expect, it } from "vitest";
import { CustomerId, MessageId, ProductHandle, ProductId, SessionId } from "../domain/shared/brand.js";
import { money } from "../domain/shared/money.js";
import type { Message } from "../domain/conversation/message.js";
import { createSession, type Session } from "../domain/conversation/session.js";
import type { Product, ProductAttributes } from "../domain/catalog/product.js";
import type {
  Clock,
  ConversationRepository,
  LlmClient,
  LlmStreamEvent,
  LlmRequest,
} from "../ports/index.js";
import { fixedClock } from "../ports/index.js";
import { createHandleMessage, toDisplayProduct, type ChatEvent } from "./handle-message.js";
import { newTurnArtifacts, type ToolRegistry } from "./tool-registry.js";
import { TOOLS } from "../prompts/tools.js";

// ---------------------------------------------------------------------------
// Fakes. Object literals, no mocking framework, no network.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

/** A scripted LLM: each entry is one turn's worth of stream events. */
function fakeLlm(turns: LlmStreamEvent[][]) {
  const seen: LlmRequest[] = [];
  let index = 0;

  const llm: LlmClient = {
    complete: async () => {
      throw new Error("complete() should not be used — the loop streams throughout");
    },
    async *stream(request) {
      seen.push(request);
      const turn = turns[index] ?? [doneEvent()];
      index += 1;
      for (const event of turn) yield event;
    },
  };

  return { llm, seen, turnsUsed: () => index };
}

const doneEvent = (stopReason: "end_turn" | "tool_use" = "end_turn"): LlmStreamEvent => ({
  type: "done",
  stopReason,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0 },
});

const text = (t: string): LlmStreamEvent => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input = {}): LlmStreamEvent => ({
  type: "tool_use",
  id,
  name,
  input,
});

function fakeRepo(initial?: Session, history: Message[] = []) {
  const saved: Session[] = [];
  const appended: Message[][] = [];
  let current = initial;

  const repo: ConversationRepository = {
    loadSession: async () => current ?? null,
    createSession: async (s) => {
      current = s;
      saved.push(s);
    },
    saveSession: async (s) => {
      current = s;
      saved.push(s);
    },
    loadRecentMessages: async () => history,
    appendMessages: async (_id, messages) => {
      appended.push([...messages]);
    },
    findSessionsByCustomer: async () => [],
  };

  return { repo, saved, appended, session: () => current };
}

/** Records calls and returns canned tool output. */
function fakeTools(
  responses: Record<string, string> = {},
  opts: { escalateOn?: string; throwOn?: string } = {},
) {
  const calls: string[] = [];

  const tools: ToolRegistry = {
    definitions: () => TOOLS,
    execute: async (call, artifacts) => {
      calls.push(call.name);
      if (opts.escalateOn === call.name) {
        artifacts.escalated = true;
        artifacts.escalationSummary = "customer wants a refund";
      }
      if (opts.throwOn === call.name) {
        return { toolCallId: call.id, content: "lookup failed", isError: true, latencyMs: 5 };
      }
      return {
        toolCallId: call.id,
        content: responses[call.name] ?? "<retrieved_knowledge/>",
        isError: false,
        latencyMs: 10,
      };
    },
  };

  return { tools, calls };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const tokensOf = (events: ChatEvent[]) =>
  events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");

function build(opts: {
  turns?: LlmStreamEvent[][];
  session?: Session;
  history?: Message[];
  toolResponses?: Record<string, string>;
  toolOpts?: { escalateOn?: string; throwOn?: string };
  maxToolHops?: number;
  clock?: Clock;
}) {
  const llm = fakeLlm(opts.turns ?? [[text("hello"), doneEvent()]]);
  const repo = fakeRepo(opts.session, opts.history ?? []);
  const tools = fakeTools(opts.toolResponses, opts.toolOpts ?? {});
  const clock = opts.clock ?? fixedClock(NOW);

  const handle = createHandleMessage({
    llm: llm.llm,
    conversations: repo.repo,
    tools: tools.tools,
    clock,
    ...(opts.maxToolHops !== undefined ? { maxToolHops: opts.maxToolHops } : {}),
  });

  const run = () =>
    collect(
      handle({
        sessionId: SessionId("s1"),
        customerId: CustomerId("c1"),
        messageId: MessageId("m1"),
        text: "do you ship to the UK?",
      }),
    );

  return { run, llm, repo, tools };
}

// ---------------------------------------------------------------------------

describe("a simple turn", () => {
  it("streams tokens and finishes", async () => {
    const { run } = build({ turns: [[text("We ship "), text("to the UK."), doneEvent()]] });

    const events = await run();

    expect(tokensOf(events)).toBe("We ship to the UK.");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("calls no tools when the model doesn't ask", async () => {
    // Not retrieving is a valid, cheap outcome. Running a vector search on "hi"
    // wastes money and adds latency.
    const { run, tools } = build({ turns: [[text("Hi there."), doneEvent()]] });

    await run();

    expect(tools.calls).toEqual([]);
  });

  it("marks the system prompt cacheable on every request", async () => {
    // Bedrock has no automatic caching — this flag is the only mechanism, and a
    // miss costs ~10x on input.
    const { run, llm } = build({});

    await run();

    expect(llm.seen[0]!.cacheSystemPrompt).toBe(true);
  });
});

describe("the tool loop", () => {
  it("executes a tool then streams the grounded answer", async () => {
    const { run, tools, llm } = build({
      turns: [
        [text("Let me check. "), toolUse("t1", "search_knowledge_base"), doneEvent("tool_use")],
        [text("Yes — 7-14 business days."), doneEvent()],
      ],
    });

    const events = await run();

    expect(tools.calls).toEqual(["search_knowledge_base"]);
    expect(tokensOf(events)).toBe("Let me check. Yes — 7-14 business days.");
    expect(llm.turnsUsed()).toBe(2);
  });

  it("streams preamble text emitted before a tool call", async () => {
    // The difference between a responsive assistant and a four-second spinner.
    const { run } = build({
      turns: [
        [text("One moment..."), toolUse("t1", "search_products"), doneEvent("tool_use")],
        [text(" Here are two."), doneEvent()],
      ],
    });

    const events = await run();
    const firstToken = events.findIndex((e) => e.type === "token");
    const firstTool = events.findIndex((e) => e.type === "tool_started");

    expect(firstToken).toBeLessThan(firstTool);
  });

  it("announces each tool so the UI can show progress", async () => {
    const { run } = build({
      turns: [
        [toolUse("t1", "search_products"), doneEvent("tool_use")],
        [text("done"), doneEvent()],
      ],
    });

    const events = await run();

    expect(events.some((e) => e.type === "tool_started")).toBe(true);
  });

  it("executes parallel tool calls together and replays them in ONE turn", async () => {
    // Splitting tool results across messages silently teaches the model to stop
    // making parallel calls — a regression with no error to catch.
    const { run, tools, llm } = build({
      turns: [
        [
          toolUse("t1", "search_knowledge_base"),
          toolUse("t2", "search_products"),
          doneEvent("tool_use"),
        ],
        [text("Both done."), doneEvent()],
      ],
    });

    await run();

    expect(tools.calls).toEqual(["search_knowledge_base", "search_products"]);

    const secondRequest = llm.seen[1]!;
    const resultTurns = secondRequest.messages.filter((m) => m.toolResults?.length);
    expect(resultTurns).toHaveLength(1);
    expect(resultTurns[0]!.toolResults).toHaveLength(2);
  });

  it("replays the assistant turn with its tool_use blocks", async () => {
    const { run, llm } = build({
      turns: [
        [text("checking"), toolUse("t1", "search_products"), doneEvent("tool_use")],
        [text("ok"), doneEvent()],
      ],
    });

    await run();

    const assistantTurn = llm.seen[1]!.messages.find((m) => m.toolCalls?.length);
    expect(assistantTurn?.role).toBe("assistant");
    expect(assistantTurn?.toolCalls?.[0]?.id).toBe("t1");
  });

  it("keeps going after a failed tool rather than aborting the turn", async () => {
    // A broken tool is information the model needs so it can apologise, not a
    // reason to kill a conversation the customer is in the middle of.
    const { run } = build({
      turns: [
        [toolUse("t1", "search_products"), doneEvent("tool_use")],
        [text("I can't check stock right now."), doneEvent()],
      ],
      toolOpts: { throwOn: "search_products" },
    });

    const events = await run();

    expect(tokensOf(events)).toContain("can't check stock");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("the hop ceiling", () => {
  it("stops looping and tells the customer", async () => {
    // An unbounded agent loop is how you wake up to a four-figure bill.
    const loopForever: LlmStreamEvent[][] = Array.from({ length: 10 }, () => [
      toolUse("t", "search_products"),
      doneEvent("tool_use"),
    ]);

    const { run, tools } = build({ turns: loopForever, maxToolHops: 2 });

    const events = await run();

    expect(tools.calls).toHaveLength(2);
    expect(tokensOf(events)).toContain("narrow it down");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("session budgets", () => {
  it("refuses before spending a token when the turn budget is gone", async () => {
    const exhausted: Session = { ...createSession(SessionId("s1"), null, NOW), turnCount: 50 };
    const { run, llm } = build({ session: exhausted });

    const events = await run();

    expect(events[0]?.type).toBe("refused");
    // The critical assertion: the LLM was never called.
    expect(llm.turnsUsed()).toBe(0);
  });

  it("refuses once escalated, regardless of remaining budget", async () => {
    const handed: Session = { ...createSession(SessionId("s1"), null, NOW), escalated: true };
    const { run, llm } = build({ session: handed });

    const events = await run();

    expect(events[0]?.type).toBe("refused");
    expect(llm.turnsUsed()).toBe(0);
  });

  it("accumulates token spend onto the session", async () => {
    const { run, repo } = build({
      turns: [
        [toolUse("t1", "search_products"), doneEvent("tool_use")],
        [text("ok"), doneEvent()],
      ],
    });

    await run();

    // Two LLM turns at 120 tokens each.
    expect(repo.session()!.tokensUsed).toBe(240);
    expect(repo.session()!.turnCount).toBe(1);
  });
});

describe("escalation", () => {
  it("marks the session escalated and reports it", async () => {
    const { run, repo } = build({
      turns: [
        [toolUse("t1", "escalate_to_human"), doneEvent("tool_use")],
        [text("Someone will be in touch."), doneEvent()],
      ],
      toolOpts: { escalateOn: "escalate_to_human" },
    });

    const events = await run();
    const done = events.at(-1);

    expect(done?.type === "done" && done.escalated).toBe(true);
    expect(repo.session()!.escalated).toBe(true);
  });
});

describe("persistence", () => {
  it("writes both turns with provenance", async () => {
    const { run, repo } = build({ turns: [[text("We ship to the UK."), doneEvent()]] });

    await run();

    const written = repo.appended[0]!;
    expect(written).toHaveLength(2);
    expect(written[0]!.role).toBe("user");
    expect(written[1]!.role).toBe("assistant");
    // promptVersion is what lets you correlate a quality shift to a deploy.
    expect(written[1]!.promptVersion).toBeTruthy();
    expect(written[1]!.usage).toBeDefined();
  });

  it("does not fail the turn when persistence fails", async () => {
    // The customer has already read the answer. Losing the transcript is a
    // monitoring problem, not a reason to show them an error afterwards.
    const { run, repo } = build({});
    repo.repo.appendMessages = async () => {
      throw new Error("DynamoDB unavailable");
    };

    const events = await run();

    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("conversation memory", () => {
  it("sends prior turns to the model", async () => {
    const history: Message[] = [
      { id: MessageId("h1"), role: "user", content: "almond nails?", createdAt: NOW - 2000 },
      { id: MessageId("h2"), role: "assistant", content: "Yes, several.", createdAt: NOW - 1000 },
    ];
    const { run, llm } = build({ history });

    await run();

    const sent = llm.seen[0]!.messages.map((m) => m.content);
    expect(sent).toContain("almond nails?");
    expect(sent.at(-1)).toBe("do you ship to the UK?");
  });
});

describe("toDisplayProduct", () => {
  const attrs = (overrides: Partial<ProductAttributes> = {}): ProductAttributes => ({
    kind: "nail-set",
    tags: [],
    shape: "almond",
    length: "short",
    finishes: ["gloss"],
    occasions: [],
    suitableFor: [],
    colourNotes: [],
    style: "Chrome",
    ...overrides,
  });

  const testProduct = (attributes: ProductAttributes): Product => ({
    id: ProductId("p1"),
    handle: ProductHandle("handle-p1"),
    title: "Sea Shell",
    description: "",
    productType: "",
    url: "https://nailzify.com/products/sea-shell",
    imageUrl: null,
    price: money(1299, "USD"),
    available: true,
    variants: [],
    attributes,
    fetchedAt: NOW,
  });

  it("joins shape and finishes as a pre-formatted, capitalised meta string", () => {
    const result = toDisplayProduct(testProduct(attrs({ shape: "almond", finishes: ["gloss"] })));

    expect(result.meta).toBe("Almond · Gloss");
  });

  it("joins multiple finishes with a slash", () => {
    // ⚠️ finishes is a LIST, not a scalar — Shopify's own metafield is
    // multi-valued (product.ts), and two live products carry two finishes at
    // once. Modelling this as one value would silently drop the second.
    const result = toDisplayProduct(testProduct(attrs({ finishes: ["gloss", "metallic"] })));

    expect(result.meta).toBe("Almond · Gloss/Metallic");
  });

  it("omits the shape segment when unknown", () => {
    const result = toDisplayProduct(testProduct(attrs({ shape: null })));

    expect(result.meta).toBe("Gloss");
  });

  it("omits the finish segment when none are known", () => {
    const result = toDisplayProduct(testProduct(attrs({ finishes: [] })));

    expect(result.meta).toBe("Almond");
  });

  it("is null when neither shape nor finish is known — not an empty string", () => {
    // Null, not "", so the widget can tell "nothing to show" from "showed an
    // empty label" and fall back to price alone rather than a stray " · $12.99".
    const result = toDisplayProduct(testProduct(attrs({ shape: null, finishes: [] })));

    expect(result.meta).toBeNull();
  });

  it("pre-formats price the same way regardless of meta", () => {
    const result = toDisplayProduct(testProduct(attrs()));

    expect(result.price).toBe("$12.99");
  });
});
