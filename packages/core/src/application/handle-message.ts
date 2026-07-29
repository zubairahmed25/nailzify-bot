/**
 * handle-message — the heart of the system.
 *
 * Reads as a description of the flow, which is the test of whether the layering
 * worked. It touches no AWS SDK, no Pinecone client, no Shopify GraphQL: every
 * dependency arrives as a port, so the whole conversation is testable against
 * object literals in milliseconds.
 */

import type { Product } from "../domain/catalog/product.js";
import { formatMoney } from "../domain/shared/money.js";
import { err, ok, type Result } from "../domain/shared/result.js";
import { MessageId, type SessionId, type CustomerId } from "../domain/shared/brand.js";
import {
  assistantMessage,
  userMessage,
  type Citation,
  type Message,
  type ToolCall,
  type ToolOutcome,
  type TokenUsage,
} from "../domain/conversation/message.js";
import {
  canAcceptTurn,
  createSession,
  escalate,
  recordTurn,
  ttlFor,
  type Session,
  type SessionRuleViolation,
} from "../domain/conversation/session.js";
import { buildWindow, DEFAULT_WINDOW_POLICY, type WindowPolicy } from "../domain/conversation/window.js";
import type { ProductId } from "../domain/shared/brand.js";
import type { Clock, ConversationRepository, LlmClient } from "../ports/index.js";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } from "../prompts/system-prompt.js";
import { newTurnArtifacts, type ToolRegistry } from "./tool-registry.js";

/**
 * Cap on tool round trips within one turn.
 *
 * An unbounded agent loop is a cost incident waiting to happen — a model that
 * keeps deciding it needs one more search will happily burn a four-figure
 * Bedrock bill overnight. Four is generous: a realistic worst case is
 * "search policy, search products, get details on one".
 */
export const MAX_TOOL_HOPS = 4;

export interface HandleMessageDeps {
  readonly llm: LlmClient;
  readonly conversations: ConversationRepository;
  readonly tools: ToolRegistry;
  readonly clock: Clock;
  readonly windowPolicy?: WindowPolicy;
  readonly maxToolHops?: number;
  readonly maxTokens?: number;
}

export interface HandleMessageCommand {
  readonly sessionId: SessionId;
  readonly customerId: CustomerId | null;
  readonly messageId: MessageId;
  readonly text: string;
}

/** Streamed to the widget over SSE. */
export type ChatEvent =
  | { readonly type: "token"; readonly text: string }
  | { readonly type: "tool_started"; readonly name: string }
  | {
      readonly type: "done";
      readonly citations: readonly Citation[];
      readonly productIds: readonly ProductId[];
      /**
       * The products shown this turn, already formatted for display.
       *
       * ⚠️ THIS IS THE ANTI-HALLUCINATION RULE AT THE PRESENTATION TIER. The
       * widget renders a card with a price on it. Sending only ids would force
       * that price to come from somewhere else — a second fetch, or parsing it
       * back out of the model's prose. The latter means the number a customer
       * reads was produced by a language model, which is exactly what the
       * two-plane rule exists to prevent.
       *
       * `price` is pre-formatted rather than sent as minor units plus a currency
       * code, so the widget cannot get the formatting wrong either. Money
       * formatting lives in one place, next to the type that enforces integer
       * minor units.
       */
      readonly products: readonly DisplayProduct[];
      readonly escalated: boolean;
      readonly usage: TokenUsage;
    }
  | { readonly type: "refused"; readonly reason: string };

/**
 * A product as the widget renders it. Every field is live as of this request.
 *
 * Deliberately NOT the domain `Product`: variants, attributes and `fetchedAt`
 * are of no use to a card and would be sent on every turn to every customer.
 */
export interface DisplayProduct {
  readonly id: ProductId;
  readonly title: string;
  /** Pre-formatted, e.g. "$13.99". Never assembled in the browser. */
  readonly price: string;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly available: boolean;
}

function dedupeById(products: readonly Product[]): readonly Product[] {
  const seen = new Set<string>();
  return products.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

export function toDisplayProduct(product: Product): DisplayProduct {
  return {
    id: product.id,
    title: product.title,
    price: formatMoney(product.price),
    url: product.url,
    imageUrl: product.imageUrl,
    available: product.available,
  };
}

export function createHandleMessage(deps: HandleMessageDeps) {
  const windowPolicy = deps.windowPolicy ?? DEFAULT_WINDOW_POLICY;
  const maxHops = deps.maxToolHops ?? MAX_TOOL_HOPS;
  const maxTokens = deps.maxTokens ?? 2048;

  return async function* handleMessage(
    command: HandleMessageCommand,
  ): AsyncIterable<ChatEvent> {
    const now = deps.clock.now();

    // ---- 1. Load or create the session --------------------------------------
    const loaded = await deps.conversations.loadSession(command.sessionId);
    let session = loaded ?? createSession(command.sessionId, command.customerId, now);

    // Capture the version AS LOADED. Every domain mutation bumps it, and a turn
    // may apply more than one (recordTurn, then escalate), so deriving the
    // expected version later from the final value is wrong — it would be off by
    // however many mutations happened and the conditional write would always
    // fail. This is the only correct reference point.
    const isNew = loaded === null;
    const loadedVersion = loaded?.version ?? 0;

    // ---- 2. Enforce budgets BEFORE spending anything -------------------------
    // Cheapest checks first. Every token spent on a request we were going to
    // reject is money burned.
    const allowed = canAcceptTurn(session);
    if (!allowed.ok) {
      yield { type: "refused", reason: refusalMessage(allowed.error) };
      return;
    }

    // ---- 3. Build the window -------------------------------------------------
    const history = await deps.conversations.loadRecentMessages(command.sessionId, 20);
    const window = buildWindow(history, session.summary, windowPolicy);

    const incoming = userMessage(command.messageId, command.text, now);
    const messages: Message[] = [...window.messages, incoming];

    // ---- 4. The tool loop ----------------------------------------------------
    const artifacts = newTurnArtifacts();
    const totals: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };

    let answer = "";
    let hops = 0;

    for (;;) {
      const toolCalls: ToolCall[] = [];
      let turnText = "";
      let stopReason: string = "end_turn";

      for await (const event of deps.llm.stream({
        model: "chat",
        system: SYSTEM_PROMPT,
        tools: deps.tools.definitions(),
        messages,
        maxTokens,
        // The system prompt and tool definitions are byte-stable across every
        // request, so they cache at ~0.1x. This flag is the only mechanism —
        // Bedrock has no automatic caching.
        cacheSystemPrompt: true,
      })) {
        switch (event.type) {
          case "text":
            turnText += event.text;
            // Forward immediately. Text emitted before a tool call is preamble
            // ("let me check that") and is worth showing — it is the difference
            // between a responsive assistant and a four-second spinner.
            yield { type: "token", text: event.text };
            break;
          case "tool_use":
            toolCalls.push({ id: event.id, name: event.name, input: event.input });
            break;
          case "done":
            stopReason = event.stopReason;
            accumulate(totals, event.usage);
            break;
        }
      }

      answer += turnText;

      if (stopReason !== "tool_use" || toolCalls.length === 0) break;

      if (hops >= maxHops) {
        // Stop rather than loop. The customer gets whatever was produced plus an
        // honest note, which beats an unbounded spend or a silent truncation.
        const note =
          "\n\nI wasn't able to finish looking that up — could you narrow it down for me?";
        answer += note;
        yield { type: "token", text: note };
        break;
      }
      hops += 1;

      for (const call of toolCalls) yield { type: "tool_started", name: call.name };

      // Execute concurrently. The model emitted these together precisely because
      // they are independent.
      const outcomes = await Promise.all(
        toolCalls.map((call) => deps.tools.execute(call, artifacts)),
      );

      messages.push(
        assistantMessage(nextId("a"), turnText, deps.clock.now(), { toolCalls }),
        toolResultTurn(outcomes, deps.clock.now()),
      );
    }

    // ---- 5. Persist ----------------------------------------------------------
    // After the stream, so none of this shows up as perceived latency.
    const finishedAt = deps.clock.now();
    const spent = totals.inputTokens + totals.outputTokens;

    session = recordTurn(session, spent, finishedAt);
    if (artifacts.escalated) session = escalate(session, finishedAt);

    const assistantTurn = assistantMessage(nextId("a"), answer, finishedAt, {
      citations: artifacts.citations,
      retrievedChunkIds: artifacts.chunkIds,
      shownProductIds: artifacts.productIds,
      usage: totals,
      promptVersion: SYSTEM_PROMPT_VERSION,
    });

    await persist(deps, session, [incoming, assistantTurn], isNew, loadedVersion);

    yield {
      type: "done",
      citations: artifacts.citations,
      productIds: artifacts.productIds,
      // De-duplicated: a turn that searches and then fetches details on the same
      // product would otherwise render it twice.
      products: dedupeById(artifacts.products).map(toDisplayProduct),
      escalated: artifacts.escalated,
      usage: totals,
    };
  };
}

// ---------------------------------------------------------------------------

async function persist(
  deps: HandleMessageDeps,
  session: Session,
  messages: readonly Message[],
  isNew: boolean,
  loadedVersion: number,
): Promise<Result<void, Error>> {
  try {
    if (isNew) await deps.conversations.createSession(session);
    else await deps.conversations.saveSession(session, loadedVersion);

    await deps.conversations.appendMessages(session.id, messages, ttlFor(session));
    return ok(undefined);
  } catch (error) {
    // A persistence failure must NOT fail a turn the customer has already read.
    // The answer was delivered; losing the transcript is a monitoring problem,
    // not a reason to show an error after the fact.
    return err(error as Error);
  }
}

function toolResultTurn(outcomes: readonly ToolOutcome[], now: number): Message {
  return {
    id: nextId("t"),
    role: "user",
    content: "",
    createdAt: now,
    // ALL results in ONE message. Splitting them across messages silently
    // teaches the model to stop making parallel tool calls.
    toolResults: outcomes,
  };
}

function accumulate(totals: TokenUsage, usage: TokenUsage): void {
  const mutable = totals as { -readonly [K in keyof TokenUsage]: TokenUsage[K] };
  mutable.inputTokens += usage.inputTokens;
  mutable.outputTokens += usage.outputTokens;
  mutable.cacheReadInputTokens += usage.cacheReadInputTokens;
}

let counter = 0;
const nextId = (prefix: string): MessageId =>
  MessageId(`${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`);

function refusalMessage(violation: SessionRuleViolation): string {
  switch (violation.code) {
    case "SESSION_ESCALATED":
      return "This conversation has been passed to a member of our team — they'll be in touch shortly.";
    case "TURN_BUDGET_EXCEEDED":
    case "TOKEN_BUDGET_EXCEEDED":
      return "We've covered a lot in this chat. Start a new one to keep going, or I can pass you to the team.";
    default:
      return "I can't continue this conversation right now.";
  }
}
