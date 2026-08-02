/**
 * Bedrock LLM client — implements the `LlmClient` port.
 *
 * ============================================================================
 * ⚠️ VERIFICATION STATUS: SHAPE-VERIFIED, NOT LIVE-VERIFIED
 * ============================================================================
 *
 * Unlike the embedder and reranker in this package, this adapter has NOT been
 * exercised against a live model. Every Claude model on the target account
 * currently returns:
 *
 *   "Model use case details have not been submitted for this account."
 *
 * That is an account gate cleared by a form in the Bedrock console, not a code
 * problem. The request/response shapes here come from the typed Anthropic SDK
 * rather than from observation — which is meaningfully weaker evidence. On this
 * project, live checks have already contradicted assumptions three times
 * (embedding dimensions, two retrieval thresholds, two Shopify nullability
 * details). Treat this file as provisional until `scripts/verify-llm.ts` runs
 * clean.
 *
 * ============================================================================
 * MODEL IDS: INFERENCE PROFILES, NOT BARE MODEL IDS
 * ============================================================================
 *
 * Measured on Bedrock:
 *
 *   anthropic.claude-sonnet-4-6           -> ValidationException (needs a profile)
 *   us.anthropic.claude-sonnet-4-6        -> reaches the model
 *
 * Newer Claude models require a CROSS-REGION INFERENCE PROFILE. The `us.` prefix
 * routes across US regions for capacity; `global.` routes worldwide. This is the
 * single most common "why doesn't my Bedrock model ID work" mistake, and the
 * error message (`ValidationException`) does not say "use a profile".
 *
 * Also note: `list-foundation-models` and `list-inference-profiles` both report
 * models the account CANNOT invoke. Listing is not access. Verify by invoking.
 */

import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmStreamEvent,
  LlmUsage,
  ModelRole,
  ToolDefinition,
} from "@nailzify/core";
import { LlmThrottled, LlmUnavailable, type Message } from "@nailzify/core";

/**
 * Model IDs per role.
 *
 * Defaults are the newest generation. If the account has not been granted them,
 * override — the port exists so this is a config change, not a code change.
 */
export interface ModelRoleMap {
  readonly chat: string;
  readonly fast: string;
  readonly judge: string;
}

export const DEFAULT_MODELS: ModelRoleMap = {
  chat: "us.anthropic.claude-sonnet-5",
  fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  judge: "us.anthropic.claude-sonnet-5",
};

/**
 * Models verified reachable on accounts without Claude 5 access.
 *
 * ⚠️ NOTHING FALLS BACK TO THIS AUTOMATICALLY, despite the name. It is a value
 * a caller may choose, not behaviour the client provides — and the deployed
 * Lambda did not choose it, so a Sonnet 5 access denial reached a customer as an
 * empty reply while this constant sat here looking like a safety net.
 *
 * Automatic fallback is deliberately NOT implemented. Silently switching models
 * on an access error changes answer quality with nobody aware it happened, and
 * "why did the bot get worse last Tuesday" is a far harder question than a 403.
 * Choose the model explicitly; let the failure be loud.
 */
export const FALLBACK_MODELS: ModelRoleMap = {
  chat: "us.anthropic.claude-sonnet-4-6",
  fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  judge: "us.anthropic.claude-sonnet-4-6",
};

export interface BedrockLlmConfig {
  readonly region: string;
  readonly models?: ModelRoleMap;
  /**
   * Inject a preconstructed client.
   *
   * Two Bedrock surfaces exist and they take DIFFERENT model-id formats:
   *   AnthropicBedrock       InvokeModel path,  `us.`/`global.` profile IDs
   *   AnthropicBedrockMantle Messages endpoint, bare `anthropic.` IDs
   *
   * We default to `AnthropicBedrock` because inference profiles are required
   * for current models on that path and it is the more broadly documented route.
   * Both expose the same `messages.create/stream` surface, so swapping is a
   * one-line change here — which is the point of the port.
   */
  readonly client?: Pick<AnthropicBedrock, "messages">;
  /**
   * Called with token usage after every request.
   *
   * Exists so `cache_read_input_tokens` is OBSERVABLE. Prompt caching fails
   * silently — a changed byte in the prefix, or a prefix under the model's
   * minimum, means you simply pay full price forever with no error. The only
   * way to know is to watch this number (docs/10-operations.md §10.7).
   */
  readonly onUsage?: (usage: LlmUsage & { model: string }) => void;
}

export function createBedrockLlmClient(config: BedrockLlmConfig): LlmClient {
  const client = config.client ?? new AnthropicBedrock({ awsRegion: config.region });
  const models = config.models ?? DEFAULT_MODELS;
  const reportUsage = config.onUsage ?? (() => {});

  const build = (request: LlmRequest) => ({
    model: models[request.model],
    max_tokens: request.maxTokens,
    // cache_control marks the END of the stable prefix. Everything before it
    // (tools render first, then system) is cacheable at ~0.1x on a hit.
    //
    // ⚠️ Bedrock has NO automatic top-level caching — the block annotation is
    // mandatory. And the minimum cacheable prefix is model-dependent (~1024
    // tokens for Sonnet-tier, ~4096 for Haiku). Below it, nothing caches and
    // nothing errors.
    system: request.cacheSystemPrompt
      ? [
          {
            type: "text" as const,
            text: request.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : request.system,
    ...(request.tools ? { tools: request.tools.map(toAnthropicTool) } : {}),
    // ⚠️ VERIFIED AGAINST THE INSTALLED SDK'S TYPES, NOT ASSUMED. AnthropicBedrock's
    // `.messages` is `Omit<Resources.Messages, 'batches' | 'countTokens'>` — the
    // exact same resource class the direct API client uses, just over a different
    // transport. `tool_choice: { type: "tool", name }` forces that one tool to be
    // called instead of leaving it optional, which is what a one-shot structured-
    // output call (document classification) needs and the customer-facing tool
    // loop never sets.
    ...(request.forceTool
      ? { tool_choice: { type: "tool" as const, name: request.forceTool } }
      : {}),
    messages: request.messages.map(toAnthropicMessage),
  });

  return {
    async complete(request) {
      try {
        const response = await client.messages.create({
          ...build(request),
          stream: false,
        });
        const usage = toUsage(response.usage);
        reportUsage({ ...usage, model: models[request.model] });
        return toLlmResponse(response, usage);
      } catch (cause) {
        throw toDomainError(cause);
      }
    },

    async *stream(request) {
      let stream;
      try {
        stream = client.messages.stream(build(request));
      } catch (cause) {
        throw toDomainError(cause);
      }

      // Accumulate streamed tool-call JSON. Tool inputs arrive as
      // `input_json_delta` fragments across many events — a partial fragment is
      // not valid JSON, so it can only be parsed once the block closes.
      const pending = new Map<number, { id: string; name: string; json: string }>();

      try {
        for await (const event of stream) {
          switch (event.type) {
            case "content_block_start": {
              if (event.content_block.type === "tool_use") {
                pending.set(event.index, {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  json: "",
                });
              }
              break;
            }
            case "content_block_delta": {
              if (event.delta.type === "text_delta") {
                yield { type: "text", text: event.delta.text };
              } else if (event.delta.type === "input_json_delta") {
                const partial = pending.get(event.index);
                if (partial) partial.json += event.delta.partial_json;
              }
              break;
            }
            case "content_block_stop": {
              const partial = pending.get(event.index);
              if (partial) {
                pending.delete(event.index);
                yield {
                  type: "tool_use",
                  id: partial.id,
                  name: partial.name,
                  // An empty-argument tool call streams as "" rather than "{}".
                  input: safeParse(partial.json),
                };
              }
              break;
            }
            default:
              break;
          }
        }

        const final = await stream.finalMessage();
        const usage = toUsage(final.usage);
        reportUsage({ ...usage, model: models[request.model] });
        yield { type: "done", stopReason: toStopReason(final.stop_reason), usage };
      } catch (cause) {
        throw toDomainError(cause);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Domain -> Anthropic
// ---------------------------------------------------------------------------

function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

/**
 * Convert one domain message into an Anthropic message param.
 *
 * The tool-loop shape is what makes this non-trivial:
 *   assistant turn -> optional text + one `tool_use` block per call
 *   user turn      -> one `tool_result` block per call, ALL IN ONE MESSAGE
 *
 * ⚠️ Splitting tool results across several user messages silently teaches the
 * model to stop making parallel tool calls — a performance regression with no
 * error to catch. Every result for a turn belongs in a single message.
 */
function toAnthropicMessage(message: Message): Anthropic.MessageParam {
  if (message.role === "assistant") {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
    return { role: "assistant", content: blocks };
  }

  if (message.toolResults?.length) {
    return {
      role: "user",
      content: message.toolResults.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.toolCallId,
        content: result.content,
        // A failed tool is INFORMATION for the model, not an exception. Flagged
        // this way it apologises gracefully instead of the turn aborting.
        is_error: result.isError,
      })),
    };
  }

  return { role: "user", content: message.content };
}

// ---------------------------------------------------------------------------
// Anthropic -> domain
// ---------------------------------------------------------------------------

function toLlmResponse(response: Anthropic.Message, usage: LlmUsage): LlmResponse {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls = response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input as Readonly<Record<string, unknown>>,
    }));

  return { text, toolCalls, stopReason: toStopReason(response.stop_reason), usage };
}

function toUsage(usage: Anthropic.Usage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    // Null when nothing was cached. Surfaced as 0 so dashboards can distinguish
    // "cache miss" from "field absent".
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function toStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      // `end_turn`, `stop_sequence`, and null all mean "the model finished".
      return "end_turn";
  }
}

function safeParse(json: string): Readonly<Record<string, unknown>> {
  if (json.trim().length === 0) return {};
  try {
    return JSON.parse(json) as Readonly<Record<string, unknown>>;
  } catch {
    // Malformed tool JSON is recoverable: return empty args and let the model's
    // own validation error come back as a tool_result. Throwing would kill an
    // otherwise-fine conversation.
    return {};
  }
}

function toDomainError(cause: unknown): Error {
  const status = (cause as { status?: number })?.status;
  const message = (cause as { message?: string })?.message ?? "Bedrock request failed";

  if (status === 429 || status === 529) {
    return new LlmThrottled(message, null, { cause });
  }
  // 403/404 here usually means model access is not granted, or an inference
  // profile is required. Both are configuration, not transient — surfacing the
  // raw message is what makes that diagnosable.
  return new LlmUnavailable(message, { cause });
}
