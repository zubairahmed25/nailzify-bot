/**
 * Tool registry — dispatches model tool calls to use cases and formats results.
 *
 * ============================================================================
 * FORMATTING IS PART OF GROUNDING
 * ============================================================================
 *
 * How results are presented measurably affects whether the model stays grounded.
 * Three choices here do real work:
 *
 *   1. Delimited blocks (<retrieved_knowledge>, <live_products>) make "cite
 *      source 2" a precise instruction rather than a hopeful one, and let the
 *      system prompt hold the two kinds of material to different rules.
 *   2. Explicit source ids give citations something to point at, and make a
 *      wrong answer diagnosable weeks later.
 *   3. The abstention instruction is COMPUTED and injected, not left to the
 *      model to infer. "Say you don't know when you don't know" is advisory;
 *      handing it the sentence makes honesty the path of least resistance.
 *
 * A tool never throws across this boundary. A failure returns a `ToolOutcome`
 * with `isError: true`, because a broken tool is information the model needs in
 * order to apologise gracefully — not a reason to abort the customer's turn.
 */

import type { ToolCall, ToolOutcome } from "../domain/conversation/message.js";
import type { Citation } from "../domain/conversation/message.js";
import type { ChunkId } from "../domain/shared/brand.js";
import type { ProductId } from "../domain/shared/brand.js";
import type { ToolDefinition } from "../ports/index.js";
import type { Clock } from "../ports/index.js";
import { formatMoney } from "../domain/shared/money.js";
import { describeOutcome } from "../domain/knowledge/retrieval-policy.js";
import { TOOL_NAMES, TOOLS } from "../prompts/tools.js";
import {
  getProductDetails,
  searchKnowledge,
  searchProducts,
  toPreferences,
  type RetrievalDeps,
} from "./retrieval.js";

/** Everything a turn surfaced, for citations, telemetry and the UI. */
export interface TurnArtifacts {
  readonly citations: Citation[];
  readonly chunkIds: ChunkId[];
  readonly productIds: ProductId[];
  escalated: boolean;
  escalationSummary: string | null;
}

export function newTurnArtifacts(): TurnArtifacts {
  return { citations: [], chunkIds: [], productIds: [], escalated: false, escalationSummary: null };
}

export interface ToolRegistry {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall, artifacts: TurnArtifacts): Promise<ToolOutcome>;
}

export interface ToolRegistryDeps extends RetrievalDeps {
  readonly clock: Clock;
}

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const currency = deps.currency ?? "USD";

  return {
    definitions: () => TOOLS,

    async execute(call, artifacts) {
      const startedAt = deps.clock.now();
      const done = (content: string, isError = false): ToolOutcome => ({
        toolCallId: call.id,
        content,
        isError,
        latencyMs: deps.clock.now() - startedAt,
      });

      try {
        switch (call.name) {
          case TOOL_NAMES.searchKnowledge:
            return done(await runKnowledgeSearch(deps, call, artifacts));

          case TOOL_NAMES.searchProducts:
            return done(await runProductSearch(deps, call, artifacts, currency));

          case TOOL_NAMES.productDetails:
            return done(await runProductDetails(deps, call, artifacts));

          case TOOL_NAMES.escalate: {
            artifacts.escalated = true;
            artifacts.escalationSummary = String(call.input["summary"] ?? "");
            return done(
              "Handoff created. Tell the customer a member of the team will follow up, " +
                "and do not attempt to resolve the issue yourself.",
            );
          }

          default:
            // A model inventing a tool name is rare but not impossible. Return
            // it as a tool error so the model can correct itself, rather than
            // throwing and killing an otherwise-fine conversation.
            return done(`Unknown tool "${call.name}". Use one of the provided tools.`, true);
        }
      } catch (error) {
        return done(
          `This lookup failed: ${(error as Error).message}. ` +
            `Tell the customer you can't check that right now. Do not guess an answer.`,
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

async function runKnowledgeSearch(
  deps: RetrievalDeps,
  call: ToolCall,
  artifacts: TurnArtifacts,
): Promise<string> {
  const query = String(call.input["query"] ?? "");
  const docType = call.input["docType"];

  const outcome = await searchKnowledge(deps, {
    query,
    ...(typeof docType === "string" ? { docType: docType as "policy" | "guide" | "faq" } : {}),
  });

  if (outcome.kind === "insufficient") {
    // The abstention instruction is generated by the policy, not improvised
    // here — one place decides what "we don't know" means.
    return describeOutcome(outcome);
  }

  const sources = outcome.chunks.map((scored, index) => {
    const { chunk } = scored;
    const sourceId = artifacts.citations.length + index + 1;

    artifacts.chunkIds.push(chunk.id);
    artifacts.citations.push({
      sourceId,
      documentId: chunk.documentId,
      chunkId: chunk.id,
      title: chunk.title,
      page: chunk.page,
    });

    const attrs = [
      `id="${sourceId}"`,
      `document="${escapeAttr(chunk.title)}"`,
      chunk.section ? `section="${escapeAttr(chunk.section)}"` : "",
      chunk.page !== null ? `page="${chunk.page}"` : "",
    ]
      .filter(Boolean)
      .join(" ");

    // The ORIGINAL chunk text, never the contextual header we embedded. The
    // header is a retrieval aid and must not reach a customer.
    return `  <source ${attrs}>\n${indent(chunk.text)}\n  </source>`;
  });

  return `<retrieved_knowledge>\n${sources.join("\n")}\n</retrieved_knowledge>`;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

async function runProductSearch(
  deps: RetrievalDeps,
  call: ToolCall,
  artifacts: TurnArtifacts,
  currency: Parameters<typeof toPreferences>[1],
): Promise<string> {
  const query = String(call.input["query"] ?? "");
  const result = await searchProducts(deps, {
    query,
    preferences: toPreferences(call.input, currency),
  });

  if (result.recommendations.length === 0) {
    // Two different situations that deserve two different answers.
    return result.allOutOfStock
      ? "Matching products exist but every one is currently out of stock. Tell the " +
          "customer, and offer to help them find an alternative."
      : "No products matched. Tell the customer you couldn't find a match and ask " +
          "what else might work for them. Do not invent products.";
  }

  const entries = result.recommendations.map((rec) => {
    const p = rec.product;
    artifacts.productIds.push(p.id);

    // Price and availability come from the live hydration in this request.
    // Nothing here originates from a vector.
    return [
      `  <product handle="${escapeAttr(p.handle)}">`,
      `    <title>${escapeText(p.title)}</title>`,
      `    <price>${formatMoney(p.price)}</price>`,
      `    <availability>${p.available ? "in_stock" : "out_of_stock"}</availability>`,
      `    <url>${escapeText(p.url)}</url>`,
      // ⚠️ Only emit attributes we actually KNOW. An unknown one is omitted, not
      // rendered as "null" and not guessed — anything that appears here, the
      // model will state to a customer as fact.
      ...(describeAttributes(p.attributes) ? [describeAttributes(p.attributes)] : []),
      `    <why_it_fits>${escapeText(rec.reasons.join("; "))}</why_it_fits>`,
      `  </product>`,
    ].join("\n");
  });

  return `<live_products>\n${entries.join("\n")}\n</live_products>`;
}

async function runProductDetails(
  deps: RetrievalDeps,
  call: ToolCall,
  artifacts: TurnArtifacts,
): Promise<string> {
  const handle = String(call.input["handle"] ?? "");
  const product = await getProductDetails(deps, handle);

  if (!product) {
    return `No product found with handle "${handle}". It may have been removed. Do not describe it from memory.`;
  }

  artifacts.productIds.push(product.id);

  const variants = product.variants
    .map(
      (v) =>
        `    <variant available="${v.available}">${escapeText(v.title)} — ${formatMoney(v.price)}` +
        // quantityAvailable is null unless the Storefront token carries inventory
        // scope. Omitting it entirely beats rendering "null" to the model.
        `${v.quantityAvailable !== null ? ` (${v.quantityAvailable} left)` : ""}</variant>`,
    )
    .join("\n");

  return [
    `<live_products>`,
    `  <product handle="${escapeAttr(product.handle)}">`,
    `    <title>${escapeText(product.title)}</title>`,
    `    <price>${formatMoney(product.price)}</price>`,
    `    <availability>${product.available ? "in_stock" : "out_of_stock"}</availability>`,
    `    <url>${escapeText(product.url)}</url>`,
    `    <variants>`,
    variants || `    <variant available="false">no variants returned</variant>`,
    `    </variants>`,
    `  </product>`,
    `</live_products>`,
  ].join("\n");
}

/**
 * Render only the attributes we actually know.
 *
 * Returns an empty string when nothing is known, so the block is omitted rather
 * than emitted empty. A product with no merchandising tags is described purely
 * by its title, description and live price — all of which are true.
 */
function describeAttributes(attrs: {
  readonly shape: string | null;
  readonly length: string | null;
  readonly finish: string | null;
}): string {
  const known = [
    attrs.shape ? `shape: ${attrs.shape}` : "",
    attrs.length ? `length: ${attrs.length}` : "",
    attrs.finish ? `finish: ${attrs.finish}` : "",
  ].filter(Boolean);

  return known.length > 0 ? `    <attributes>${known.join(" | ")}</attributes>` : "";
}

// ---------------------------------------------------------------------------
// Escaping
//
// Retrieved document text is UNTRUSTED as far as prompt structure goes. A
// document containing "</retrieved_knowledge>" could otherwise close the block
// early and make following text look like system-level instruction. Cheap
// defence against indirect prompt injection (docs/10-operations.md §10.6).
// ---------------------------------------------------------------------------

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (value: string): string => escapeText(value).replace(/"/g, "&quot;");

const indent = (text: string): string =>
  text
    .split("\n")
    .map((l) => `    ${escapeText(l)}`)
    .join("\n");
