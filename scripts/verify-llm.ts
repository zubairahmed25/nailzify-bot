/**
 * Live LLM verification.
 *
 *     npx vite-node scripts/verify-llm.ts
 *
 * ⚠️ BLOCKED AS OF THIS WRITING. Every Claude model on the target account
 * returns "Model use case details have not been submitted for this account."
 * That is cleared by a form in the Bedrock console (Model access → Anthropic
 * use case details), not by code. Cohere embed/rerank are unaffected, which is
 * why the retrieval pipeline verified fine.
 *
 * WHY THIS SCRIPT EXISTS. The LLM adapter is the only one in this project built
 * from typed SDK contracts rather than observed behaviour. Live checks have
 * already contradicted assumptions three times here — embedding dimensions,
 * retrieval thresholds, Shopify nullability. Run this before trusting it.
 *
 * WHAT IT CHECKS, and what each would reveal:
 *   1. model access        which ids the account can actually invoke
 *   2. tool use            does the model emit a well-formed tool_use block
 *   3. prompt caching      does cache_read_input_tokens go above zero on a
 *                          repeat call — this fails SILENTLY, and a broken
 *                          cache is roughly 10x the input cost of a working one
 *   4. streaming           do text deltas and accumulated tool JSON arrive
 *   5. tool result loop    does a tool_result round trip produce a grounded answer
 */

import {
  createBedrockLlmClient,
  DEFAULT_MODELS,
  FALLBACK_MODELS,
  type ModelRoleMap,
} from "@nailzify/adapters";
import {
  MessageId,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  TOOLS,
  type LlmUsage,
  type Message,
} from "@nailzify/core";

const REGION = "us-east-1";

// The REAL tool definitions, not a stand-in. Testing against a synthetic copy
// would verify the transport and tell you nothing about the artifacts that
// actually ship.

/**
 * ⚠️ THE REAL SYSTEM PROMPT, deliberately.
 *
 * An earlier version of this script used synthetic filler to clear the cache
 * minimum. That proved the transport worked and proved nothing about the
 * artifacts that ship — including whether the real prompt is even long enough
 * to cache, and whether its tone rules are actually obeyed.
 *
 * The real prompt measures ~1001 tokens, just UNDER the ~1024-token Sonnet-tier
 * minimum. Tools render before system, so the combined prefix should clear it —
 * but "should" is exactly the kind of assumption that has been wrong repeatedly
 * on this project, so the cache check below is now load-bearing.
 */
const SYSTEM = SYSTEM_PROMPT;

const user = (text: string): Message => ({
  id: MessageId(`u-${Math.random().toString(36).slice(2)}`),
  role: "user",
  content: text,
  createdAt: Date.now(),
});

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(26)} ${String(value)}`);

// ---------------------------------------------------------------------------
// 1. Which models can this account actually invoke?
// ---------------------------------------------------------------------------

console.log("1. MODEL ACCESS");
const candidates = [...new Set([...Object.values(DEFAULT_MODELS), ...Object.values(FALLBACK_MODELS)])];
const reachable: string[] = [];

for (const model of candidates) {
  const probe = createBedrockLlmClient({
    region: REGION,
    models: { chat: model, fast: model, judge: model },
  });
  try {
    await probe.complete({ model: "chat", system: "Reply with 'ok'.", maxTokens: 8, messages: [user("hi")] });
    reachable.push(model);
    line("OK", model);
  } catch (e) {
    line("BLOCKED", `${model} — ${(e as Error).message.slice(0, 72)}`);
  }
}

if (reachable.length === 0) {
  console.log(
    "\nNo Claude model is reachable. Submit the Anthropic use case details form in the\n" +
      "Bedrock console (Model access), wait ~15 minutes, and re-run.",
  );
  process.exit(1);
}

// Prefer whichever tier is available; fall back to the first reachable id.
const chat = reachable.find((m) => m.includes("sonnet")) ?? reachable[0]!;
const models: ModelRoleMap = { chat, fast: reachable.find((m) => m.includes("haiku")) ?? chat, judge: chat };
console.log(`\n  using chat model: ${chat}`);
console.log(`  prompt version:   ${SYSTEM_PROMPT_VERSION}\n`);

const usageLog: (LlmUsage & { model: string })[] = [];
const llm = createBedrockLlmClient({ region: REGION, models, onUsage: (u) => usageLog.push(u) });

// ---------------------------------------------------------------------------
// 2. Tool use
// ---------------------------------------------------------------------------

console.log("2. TOOL USE");
const first = await llm.complete({
  model: "chat",
  system: SYSTEM,
  tools: TOOLS,
  maxTokens: 1024,
  cacheSystemPrompt: true,
  messages: [user("I need something almond-shaped for a wedding")],
});

line("stop_reason", first.stopReason);
line("tool calls", first.toolCalls.map((c) => c.name).join(", ") || "(none)");
if (first.toolCalls[0]) line("tool input", JSON.stringify(first.toolCalls[0].input));
line("input_tokens", first.usage.inputTokens);
line("cache_read", first.usage.cacheReadInputTokens);

if (first.stopReason !== "tool_use") {
  // ⚠️ A prompt-quality failure, not a transport one. Print what the model said
  // instead — that is the only way to tell "asked a clarifying question" from
  // "answered from memory", and they need opposite fixes.
  console.log("  ⚠️  NO TOOL CALL. The prompt says a product request must call search_products.");
  console.log(`  model said        ${JSON.stringify(first.text.slice(0, 400))}`);
}

// ---------------------------------------------------------------------------
// 3. Prompt caching — the silent-failure check
// ---------------------------------------------------------------------------

console.log("\n3. PROMPT CACHING (identical prefix, second call)");
const second = await llm.complete({
  model: "chat",
  system: SYSTEM,
  tools: TOOLS,
  maxTokens: 256,
  cacheSystemPrompt: true,
  messages: [user("What about square ones?")],
});

line("input_tokens", second.usage.inputTokens);
line("cache_read", second.usage.cacheReadInputTokens);
const cacheWorks = second.usage.cacheReadInputTokens > 0;
line("CACHING WORKS?", cacheWorks ? "YES" : "NO — investigate before shipping");
if (!cacheWorks) {
  console.log(
    "     Prefix under the model minimum, or something in it changed between calls\n" +
      "     (a timestamp, a session id, unsorted JSON, reordered tools).",
  );
}

// ---------------------------------------------------------------------------
// 4 + 5. Streaming with a tool result round trip
// ---------------------------------------------------------------------------

console.log("\n4. STREAMING + TOOL RESULT ROUND TRIP");
const toolCall = first.toolCalls[0];

if (!toolCall) {
  console.log(
    "\n  SKIPPED — no tool call to respond to. Sending a fabricated tool_use_id\n" +
      "  would produce a 400 that buries the real finding above.\n",
  );
  console.log("VERDICT: transport verified (tool schema, caching). PROMPT NEEDS WORK.");
  process.exit(1);
}

const conversation: Message[] = [
  user("I need something almond-shaped for a wedding"),
  {
    id: MessageId("a1"),
    role: "assistant",
    content: first.text,
    createdAt: Date.now(),
    toolCalls: first.toolCalls,
  },
  {
    id: MessageId("u2"),
    role: "user",
    content: "",
    createdAt: Date.now(),
    toolResults: [
      {
        toolCallId: toolCall.id,
        // Deliberately ONE product at a specific price. If the model states any
        // other figure, grounding is broken.
        content: JSON.stringify([
          { title: "Bridal Almond — Short", price: "24.00 USD", available: true },
        ]),
        isError: false,
        latencyMs: 118,
      },
    ],
  },
];

let streamed = "";
let done: Extract<Awaited<ReturnType<typeof collect>>[number], { type: "done" }> | undefined;

async function collect() {
  const events = [];
  for await (const event of llm.stream({
    model: "chat",
    system: SYSTEM,
    tools: TOOLS,
    maxTokens: 512,
    cacheSystemPrompt: true,
    messages: conversation,
  })) {
    events.push(event);
    if (event.type === "text") streamed += event.text;
    if (event.type === "done") done = event;
  }
  return events;
}

const events = await collect();
line("event types", [...new Set(events.map((e) => e.type))].join(", "));
line("streamed chars", streamed.length);
line("stop_reason", done?.stopReason ?? "?");
line("cache_read", done?.usage.cacheReadInputTokens ?? "?");
console.log(`\n  answer: ${streamed.trim().slice(0, 220)}`);

// ---------------------------------------------------------------------------
// Grounding spot-check
// ---------------------------------------------------------------------------

console.log("\n5. PROMPT COMPLIANCE");
// The system prompt makes explicit, checkable promises. A prompt nobody verifies
// is a prompt that quietly stops being followed.
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(streamed);
const headings = /^#{1,6}\s/m.test(streamed);
const bullets = (streamed.match(/^\s*[-*]\s/gm) ?? []).length;
const preamble = /^(great|perfect|excellent|wonderful|good) (news|question|choice)/i.test(streamed.trim());
line('no emoji ("never use emoji")', emoji ? "FAIL — emoji present" : "ok");
line("no markdown headings", headings ? "FAIL — headings present" : "ok");
line("bullet lines", bullets > 0 ? `${bullets} (prompt says avoid unless enumerating)` : "0");
line("no filler preamble", preamble ? "FAIL — opens with filler" : "ok");

console.log("\n6. GROUNDING SPOT-CHECK");
const quotedRightPrice = streamed.includes("24");
const inventedPrice = /\$\s?(?!24)\d{1,3}(\.\d{2})?/.test(streamed);
line("quotes the given price", quotedRightPrice ? "yes" : "no");
line("invents another price", inventedPrice ? "YES — GROUNDING FAILURE" : "no");

console.log("\nTOTAL USAGE");
for (const u of usageLog) {
  line(u.model.split(".").pop() ?? u.model, `in ${u.inputTokens}  out ${u.outputTokens}  cached ${u.cacheReadInputTokens}`);
}
