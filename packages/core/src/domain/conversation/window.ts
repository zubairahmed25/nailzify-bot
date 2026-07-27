/**
 * Conversation windowing.
 *
 * THE PROBLEM THIS SOLVES. The Messages API is stateless — it remembers nothing
 * between calls. "Conversation memory" is entirely something we implement by
 * resending history every turn, and every resent message is billed as input
 * tokens again.
 *
 * Send everything, and cost grows QUADRATICALLY in turn count: turn 20 pays for
 * turns 1–19 all over again. A long support conversation quietly becomes the most
 * expensive thing your system does.
 *
 * THE FIX. Keep the last N turns verbatim (recency is what matters for
 * coherence), and compress everything older into one rolling summary. Cost per
 * turn becomes roughly flat instead of climbing.
 *
 * WHY THIS FILE IS A PURE FUNCTION. No clock, no database, no network — inputs
 * in, window out. That makes the single most cost-sensitive decision in the
 * system exhaustively testable in milliseconds, with no mocks. Push logic like
 * this out of handlers and into pure functions wherever you can; it is the
 * cheapest testability win available.
 */

import { estimateTokens, type Message } from "./message.js";

export interface WindowPolicy {
  /** Recent turns kept word-for-word. A "turn" is one message. */
  readonly maxVerbatimMessages: number;
  /**
   * Soft ceiling on estimated tokens for the message list.
   *
   * Soft, because we never drop the most recent user message — an answer to the
   * wrong question is worse than an expensive one.
   */
  readonly maxEstimatedTokens: number;
}

export const DEFAULT_WINDOW_POLICY: WindowPolicy = {
  // 10 messages ≈ 5 exchanges. Enough for a customer to say "the second one"
  // and be understood, without dragging the whole conversation along.
  maxVerbatimMessages: 10,
  maxEstimatedTokens: 8_000,
};

export interface ConversationWindow {
  /** Compressed older context, or null when nothing has been dropped yet. */
  readonly summary: string | null;
  readonly messages: readonly Message[];
  /** How many messages fell out — the signal that a re-summarize is due. */
  readonly droppedCount: number;
  readonly estimatedTokens: number;
}

/**
 * Build the message window for one request.
 *
 * @param history       Full conversation, oldest first.
 * @param existingSummary Rolling summary of everything already compressed.
 */
export function buildWindow(
  history: readonly Message[],
  existingSummary: string | null,
  policy: WindowPolicy = DEFAULT_WINDOW_POLICY,
): ConversationWindow {
  if (history.length === 0) {
    return { summary: existingSummary, messages: [], droppedCount: 0, estimatedTokens: 0 };
  }

  // 1. Recency cut. Keep the newest N.
  const startIndex = Math.max(0, history.length - policy.maxVerbatimMessages);
  let kept = history.slice(startIndex);
  let dropped = startIndex;

  // 2. Token cut. A few long messages can blow the budget even inside N, so trim
  //    from the OLDEST end until we fit — recency is what we are protecting.
  let tokens = estimateWindowTokens(kept, existingSummary);
  while (tokens > policy.maxEstimatedTokens && kept.length > 1) {
    kept = kept.slice(1);
    dropped += 1;
    tokens = estimateWindowTokens(kept, existingSummary);
  }

  // `kept.length > 1` above guarantees we never drop the final message, even if
  // it alone exceeds the budget. Answering the wrong question to save tokens is
  // not a trade worth making; the API's own limits are the real backstop.

  return {
    summary: existingSummary,
    messages: kept,
    droppedCount: dropped,
    estimatedTokens: tokens,
  };
}

function estimateWindowTokens(messages: readonly Message[], summary: string | null): number {
  const summaryTokens = summary ? estimateTokens(summary) : 0;
  // +8 per message is rough overhead for role markers and content-block framing.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, summaryTokens);
}

/**
 * Should we regenerate the rolling summary?
 *
 * Summarizing costs an LLM call, so we do it on a threshold rather than every
 * turn. Batching the compression keeps the amortized cost negligible.
 */
export function needsResummarize(window: ConversationWindow, threshold = 6): boolean {
  return window.droppedCount >= threshold;
}

/**
 * Messages to feed the summarizer: everything that fell out of the window.
 *
 * Note the existing summary is passed alongside these by the caller, so
 * summarization is INCREMENTAL — we compress "previous summary + newly dropped
 * turns" rather than re-reading the entire history each time. That keeps the
 * summarization call itself from growing without bound.
 */
export function messagesToSummarize(
  history: readonly Message[],
  window: ConversationWindow,
): readonly Message[] {
  return history.slice(0, window.droppedCount);
}
