/**
 * Tool definitions.
 *
 * ============================================================================
 * TOOL DESCRIPTIONS ARE PROMPTS
 * ============================================================================
 *
 * The model chooses tools almost entirely from these descriptions. A sentence
 * placed here does more work than the same sentence in the system prompt,
 * because it sits at the decision point. Be prescriptive about WHEN to call,
 * not just what the tool does.
 *
 * ============================================================================
 * THE TOOL SURFACE IS THE SECURITY BOUNDARY
 * ============================================================================
 *
 * Every tool here is READ-ONLY. There is no cancel_order, no apply_discount, no
 * update_customer. A perfectly executed prompt injection against this agent can,
 * at worst, search a public product catalogue.
 *
 * That is not a prompt-engineering achievement, it is an architectural one. You
 * cannot reliably stop a model from being convinced — so do not make the model
 * the security boundary. Make the tool surface the boundary, and back it with
 * IAM (docs/10-operations.md §10.6).
 *
 * ⚠️ Adding a tool that mutates anything reopens this. Read Phase 12 §12.6
 * before you do.
 *
 * ORDER IS LOAD-BEARING: this array is part of the cached prompt prefix.
 * Reordering it invalidates the cache. Keep it stable.
 */

import type { ToolDefinition } from "../ports/index.js";

export const TOOL_NAMES = {
  searchKnowledge: "search_knowledge_base",
  searchProducts: "search_products",
  productDetails: "get_product_details",
  escalate: "escalate_to_human",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.searchKnowledge,
    description:
      "Search Nailzify's company documents. This includes shipping policy, returns policy, " +
      "sizing guide, application instructions, nail care guide, and FAQs — but the store can " +
      "add or update documents on ANY subject at any time (e.g. company background, who owns " +
      "or runs the store, store history, other announcements), so this list is illustrative, " +
      "not exhaustive. " +
      "Call this whenever the customer asks about policies, procedures, shipping, returns, " +
      "refunds, sizing, measuring, application, removal, care, or asks any other factual " +
      "question about the store or company that the product catalog would not answer. Do not " +
      "assume a topic is out of scope just because it is not named above — search first. " +
      "Do not answer questions in these areas from memory — you do not know Nailzify's terms " +
      "or details unless you search for them.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, phrased as the customer's underlying question. " +
            "Resolve pronouns first: 'do those come in short?' should be searched as " +
            "'do almond press-on nails come in short length'.",
        },
        docType: {
          type: "string",
          enum: ["policy", "guide", "faq"],
          description:
            "Optional filter. Use 'policy' for shipping/returns terms, 'guide' for " +
            "sizing/application/care instructions. Omit if unsure — filtering wrongly " +
            "hides the answer.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },

  {
    name: TOOL_NAMES.searchProducts,
    description:
      "Find press-on nail products matching a customer's preferences. Returns live product " +
      "data including current price and stock. " +
      "Call this for any request to find, suggest, recommend, or compare products. " +
      "Results are the only products you may recommend — never recommend from memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of what the customer is looking for.",
        },
        // Only the four shapes and three lengths Nailzify actually sells.
        // Offering "stiletto" here would let the model filter on it, get an
        // empty result, and then have to explain an absence — inviting it to
        // invent a reason. An enum the store cannot satisfy is a trap.
        shape: {
          type: "string",
          enum: ["almond", "coffin", "square", "oval"],
        },
        length: { type: "string", enum: ["short", "medium", "long"] },
        occasion: {
          type: "string",
          enum: ["everyday", "bridal", "party", "professional", "holiday"],
        },
        experience: {
          type: "string",
          enum: ["beginner", "comfortable", "experienced"],
          description: "Set to 'beginner' if the customer is new to press-on nails.",
        },
        maxPriceMinor: {
          type: "integer",
          description:
            "Budget ceiling in minor units — cents for USD. $20 is 2000. " +
            "Only set this if the customer stated a budget.",
        },
        styleNotes: {
          type: "array",
          items: { type: "string" },
          description:
            "Colour, finish or style cues, e.g. ['pink', 'matte', 'chrome', 'cat-eye']. " +
            "Style is the dimension customers most often name — put words like " +
            "'chrome', 'french', 'ombre' or 'glitter' here rather than in shape.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },

  {
    name: TOOL_NAMES.productDetails,
    description:
      "Get full live details for one product by its handle — every variant, per-variant " +
      "stock, sizes, and current price. " +
      "Call this when a customer asks about a specific product's sizes, variants, or " +
      "availability. Use a handle returned by search_products.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle, e.g. 'autumn-almond-short'.",
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },

  {
    name: TOOL_NAMES.escalate,
    description:
      "Hand this conversation to a human agent. " +
      "Call this for order-specific issues, refund requests, complaints, damaged or " +
      "incorrect deliveries, payment problems, or anything you cannot resolve from " +
      "documentation. Do not attempt to resolve these yourself — you have no access to " +
      "orders or accounts.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason for the handoff, e.g. 'refund request for order #1234'.",
        },
        summary: {
          type: "string",
          description:
            "Summary of the conversation so far, written for the agent picking it up. " +
            "Include what the customer wants and anything already established.",
        },
      },
      required: ["reason", "summary"],
      additionalProperties: false,
    },
  },
];
