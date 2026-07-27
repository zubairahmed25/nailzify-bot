/**
 * Messages and tool calls.
 *
 * A note on shape: this deliberately mirrors the Messages API structure (roles,
 * content blocks, tool_use / tool_result pairing) without importing any vendor
 * SDK. We get a model that maps cleanly onto the wire format, but the domain
 * stays swappable between Bedrock and Claude Platform on AWS — which is the whole
 * reason the `LlmClient` port exists (docs/02-aws-services.md §2.0).
 */

import type { ChunkId, DocumentId, MessageId, ProductId } from "../shared/brand.js";

export type Role = "user" | "assistant";

/** A tool the model asked us to run. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * What a tool returned.
 *
 * `isError: true` is a normal, expected outcome — not an exception. See
 * result.ts for why: a failed tool is information the model needs so it can
 * apologise gracefully, rather than a reason to abort the turn.
 */
export interface ToolOutcome {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
  readonly latencyMs: number;
}

/**
 * A pointer from an answer back to the source that supports it.
 *
 * Citations are the strongest signal available that the bot is not making things
 * up, because a customer can check them. They are also what makes a wrong answer
 * diagnosable weeks later (docs/06-data-model.md §6.1).
 */
export interface Citation {
  readonly sourceId: number;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
  readonly title: string;
  readonly page: number | null;
}

/** Token accounting, carried per-turn so cost is attributable. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Tokens served from the prompt cache at ~0.1x price.
   *
   * Worth surfacing explicitly: if this is 0 across repeated turns, caching is
   * silently broken and the bill is roughly 10x what it should be on the prefix.
   * See docs/10-operations.md §10.7 for the usual causes.
   */
  readonly cacheReadInputTokens: number;
}

export interface Message {
  readonly id: MessageId;
  readonly role: Role;
  readonly content: string;
  readonly createdAt: number;

  /**
   * Tool results this turn carries back to the model.
   *
   * User turns only. Added when the LLM adapter revealed the gap: a tool loop
   * needs to replay the full `tool_use` -> `tool_result` pairing, and a Message
   * that only held a content string could not express the second half. The API
   * REQUIRES one result per call — omitting one is a hard 400, not a graceful
   * degradation.
   */
  readonly toolResults?: readonly ToolOutcome[];

  /** Assistant turns only — provenance for debugging and audit. */
  readonly toolCalls?: readonly ToolCall[];
  readonly citations?: readonly Citation[];
  readonly retrievedChunkIds?: readonly ChunkId[];
  readonly shownProductIds?: readonly ProductId[];
  readonly usage?: TokenUsage;
  /** Which system prompt produced this. Lets you correlate quality to versions. */
  readonly promptVersion?: string;
}

export const userMessage = (
  id: MessageId,
  content: string,
  createdAt: number,
): Message => ({ id, role: "user", content, createdAt });

export const assistantMessage = (
  id: MessageId,
  content: string,
  createdAt: number,
  provenance: Omit<Message, "id" | "role" | "content" | "createdAt"> = {},
): Message => ({ id, role: "assistant", content, createdAt, ...provenance });

/** Rough token estimate for budgeting only — never for billing. */
export function estimateTokens(text: string): number {
  // ~4 characters per token is a serviceable heuristic for English prose. It is
  // NOT accurate, and deliberately so: the real count comes back from the API in
  // `usage`. This exists to decide "is this window getting too big?" before we
  // spend money finding out.
  return Math.ceil(text.length / 4);
}
