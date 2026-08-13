import type { ToolCall } from "../domain/conversation/message.js";
import { TOOL_NAMES } from "../prompts/tools.js";

export const QUICK_ACTION_INTENTS = [
  "help_choose",
  "current_promos",
  "wear_care",
  "my_order",
  "best_sellers",
] as const;

export type QuickActionIntent = (typeof QUICK_ACTION_INTENTS)[number];

export const isQuickActionIntent = (value: unknown): value is QuickActionIntent =>
  typeof value === "string" &&
  (QUICK_ACTION_INTENTS as readonly string[]).includes(value);

export interface QuickActionPlan {
  /** The unambiguous customer request shown to the model for this turn. */
  readonly modelText: string;
  /** A server-owned lookup. When present, the model never chooses its inputs. */
  readonly toolCall?: ToolCall;
}

export function quickActionPlan(
  intent: QuickActionIntent,
  toolCallId: string,
): QuickActionPlan {
  switch (intent) {
    case "help_choose":
      return {
        modelText:
          "I want help choosing a press-on nail set. Ask me one concise question about " +
          "my shape, length, occasion, or style preferences before recommending products.",
      };

    case "current_promos":
      return {
        modelText: "What current Nailzify promotions or offers are available?",
        toolCall: {
          id: toolCallId,
          name: TOOL_NAMES.searchKnowledge,
          input: {
            query:
              "current Nailzify promotions, bundles, offers, discounts, and free shipping deals",
          },
        },
      };

    case "wear_care":
      return {
        modelText:
          "How should I apply, wear, care for, reuse, and safely remove Nailzify press-on nails?",
        toolCall: {
          id: toolCallId,
          name: TOOL_NAMES.searchKnowledge,
          input: {
            query:
              "how to apply, wear, care for, reuse, and safely remove Nailzify press-on nails",
            docType: "guide",
          },
        },
      };

    case "my_order":
      return {
        modelText:
          "I need help with an order. Ask one concise question to understand whether I need " +
          "tracking, a change, a return, or something else. Do not claim access to my order.",
      };

    case "best_sellers":
      return {
        modelText: "Show me Nailzify's best-selling or most popular press-on nail sets.",
        toolCall: {
          id: toolCallId,
          name: TOOL_NAMES.searchProducts,
          input: {
            query: "Nailzify best-selling and most popular press-on nail sets",
          },
        },
      };
  }
}
