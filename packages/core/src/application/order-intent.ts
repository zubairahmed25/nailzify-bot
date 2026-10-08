import type { QuickActionIntent } from "./quick-actions.js";

export type OrderIntent = "lookup" | "support" | "none";

/**
 * Route live order reads before retrieval or model generation.
 *
 * Mutation and problem language remains a support request. General policy
 * questions remain knowledge questions. The matcher is intentionally narrow:
 * an uncertain phrase should continue through the existing guarded assistant,
 * not unexpectedly ask a shopper to sign in.
 */
export function classifyOrderIntent(
  text: string,
  quickAction?: QuickActionIntent,
): OrderIntent {
  if (quickAction === "my_order") return "lookup";

  const normalized = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || asksForPolicy(normalized)) return "none";
  if (asksForMutationOrProblem(normalized)) return "support";

  if (
    /\b(where|track|tracking|status|shipped|shipping|delivered|delivery|arrive|arrival)\b.*\b(order|package|shipment)\b/.test(normalized) ||
    /\b(order|package|shipment)\b.*\b(where|track|tracking|status|shipped|delivered|arrive|arrival)\b/.test(normalized) ||
    /\b(show|view|find|check|see|look up)\b.*\b(my\s+)?orders?\b/.test(normalized) ||
    /^(my order|my orders|order status|track order|track my order)$/.test(normalized) ||
    /\bwhat did i (order|buy|purchase)\b/.test(normalized)
  ) {
    return "lookup";
  }

  return "none";
}

function asksForPolicy(text: string): boolean {
  return /\b(policy|policies|rules|terms|how long|usually|normally|do you|can i)\b/.test(text) &&
    /\b(shipping|delivery|tracking|order|return|refund)\b/.test(text);
}

function asksForMutationOrProblem(text: string): boolean {
  return (
    /\b(cancel|change|edit|update|modify)\b.*\border\b/.test(text) ||
    /\b(return|refund|exchange)\b.*\b(order|item|purchase|this|it)\b/.test(text) ||
    /\b(change|update)\b.*\b(address|shipping address)\b/.test(text) ||
    /\b(damaged|defective|wrong|missing|lost|stolen)\b.*\b(item|order|delivery|package|product)\b/.test(text) ||
    /\b(payment|charged)\b.*\b(failed|problem|issue|twice|duplicate|wrong)\b/.test(text)
  );
}
