import type { ToolCall } from "../domain/conversation/message.js";
import { TOOL_NAMES } from "../prompts/tools.js";

export interface HumanHandoffPlan {
  readonly toolCall: ToolCall;
}

/**
 * Explicit service actions use a stable application route instead of relying
 * on the model to remember to call the handoff tool. Policy questions remain
 * open ended and continue through knowledge retrieval.
 */
export function humanHandoffPlan(text: string, toolCallId: string): HumanHandoffPlan | null {
  const normalized = text.toLowerCase().replace(/[^a-z0-9#\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || asksForPolicy(normalized)) return null;

  const reason = handoffReason(normalized);
  if (!reason) return null;

  return {
    toolCall: {
      id: toolCallId,
      name: TOOL_NAMES.escalate,
      input: {
        reason,
        summary: `Customer requested human help. Their latest message was: ${text}`,
      },
    },
  };
}

function asksForPolicy(text: string): boolean {
  return /\b(policy|policies|terms|eligible|eligibility|window|rules)\b/.test(text) ||
    /\b(what is|what s|how do|do you accept|are refunds|are returns)\b/.test(text);
}

function handoffReason(text: string): string | null {
  if (
    /^(refund|refunds)$/.test(text) ||
    /\b(i want|i need|give me|request|process|issue|get)\s+(a\s+)?refund\b/.test(text) ||
    /\brefund\s+(my|this|the)\b/.test(text)
  ) return "Customer requested a refund";

  if (/\b(cancel|change|track)\s+(my|an|the)\s+order\b/.test(text)) {
    return "Customer needs help with an existing order";
  }

  if (/\b(damaged|defective|wrong|missing)\s+(item|order|delivery|product|nails?)\b/.test(text)) {
    return "Customer reported an order or product problem";
  }

  if (/\b(payment|charged)\b.*\b(failed|problem|issue|twice|duplicate|wrong)\b/.test(text)) {
    return "Customer reported a payment problem";
  }

  return null;
}
