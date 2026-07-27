/**
 * Live end-to-end retrieval check.
 *
 *     npx vite-node scripts/verify-retrieval.ts
 *
 * Runs the real pipeline — chunk -> embed (Bedrock) -> index -> search — against
 * a miniature Nailzify corpus, and prints the score distribution.
 *
 * ⚠️ MAKES REAL BEDROCK CALLS. Costs a fraction of a cent per run. Deliberately
 * NOT part of `npm test`: the unit suite must stay free, offline and instant.
 *
 * WHY THIS EXISTS. Retrieval thresholds cannot be reasoned about from first
 * principles — the numbers depend entirely on the embedding model. This script
 * is how you obtain them. Its first run is what revealed that a hand-picked
 * relevance floor of 0.35 would have abstained on four of five correct answers,
 * and that raw cosine cannot separate correct from off-topic at all on this
 * model. See DEFAULT_RETRIEVAL_POLICY in @nailzify/core.
 *
 * RE-RUN THIS whenever you change the embedding model, its dimensions, or the
 * chunking policy. Scores from different models are not comparable.
 */
import { chunkMarkdown, structuralContextHeader, embeddingText } from "@nailzify/core";
import { createBedrockEmbedder, createInMemoryVectorStore } from "@nailzify/adapters";

const SHIPPING = `
# Nailzify Shipping Policy

## Domestic Shipping
Standard shipping within the United States takes 3-5 business days.
Orders placed before 2pm ET ship the same business day. Free shipping
applies to orders over $35.

## International Shipping
We ship to Canada, the United Kingdom, and Australia. International
delivery takes 7-14 business days. Customers are responsible for any
customs duties or import taxes charged on arrival.
`;

const CARE = `
# Nail Care Guide

## Wear Time
With correct application, a set stays on for 7 to 10 days. Oily nail
beds may shorten this. Avoid prolonged soaking in hot water during the
first 24 hours.

## Safe Removal
Soak fingertips in warm soapy water for 10 minutes, then gently lift
each nail from the side using a wooden stick. Never force or peel a
press-on off, as this removes layers of the natural nail.
`;

const RETURNS = `
# Return Policy

## Eligibility
Returns are accepted within 30 days of delivery. Products must be
unopened and in original packaging with all seals intact.

## Hygiene Exclusions
For hygiene reasons we cannot accept returns on any set where the
seal has been broken, even if the nails were never worn.
`;

const DOCS = [
  { id: "shipping-policy", title: "Shipping Policy", markdown: SHIPPING },
  { id: "nail-care-guide", title: "Nail Care Guide", markdown: CARE },
  { id: "returns-policy", title: "Return Policy", markdown: RETURNS },
];

const embedder = createBedrockEmbedder({
  region: "us-east-1",
  modelId: "cohere.embed-v4:0",
  dimensions: 1024,
});
const store = createInMemoryVectorStore();

// ---- INGEST ----
console.log("INGEST");
let totalChunks = 0;
for (const doc of DOCS) {
  const drafts = chunkMarkdown(doc.markdown);
  const texts = drafts.map((d) =>
    embeddingText({ text: d.text, contextHeader: structuralContextHeader(doc.title, d) }),
  );
  const vectors = await embedder.embedBatch(texts, "document");

  await store.upsert(
    "knowledge",
    drafts.map((d, i) => ({
      id: `${doc.id}#s${d.sectionIndex}#c${d.chunkIndex}`,
      values: vectors[i]!,
      metadata: {
        documentId: doc.id,
        title: doc.title,
        section: d.section,
        docType: "policy",
        text: d.text,
        contextHeader: structuralContextHeader(doc.title, d),
        version: "2026-07-26",
        embeddingModel: embedder.modelId,
      },
    })),
  );
  totalChunks += drafts.length;
  console.log(`  ${doc.id.padEnd(18)} ${drafts.length} chunks`);
}
console.log(`  total: ${totalChunks} vectors, ${embedder.dimensions} dims\n`);

// ---- SEARCH ----
// Each question deliberately avoids the wording of its target chunk, so a
// keyword search would fail. This is what "semantic" has to earn.
const QUESTIONS: { q: string; expect: string }[] = [
  { q: "how long do they stay on before falling off?", expect: "nail-care-guide" },
  { q: "can I get my money back if I opened the packet?", expect: "returns-policy" },
  { q: "do you post to Britain?", expect: "shipping-policy" },
  { q: "what's the safest way to take them off without wrecking my nails?", expect: "nail-care-guide" },
  { q: "will I be charged extra fees at the border?", expect: "shipping-policy" },
];

console.log("SEARCH");
let passed = 0;
for (const { q, expect } of QUESTIONS) {
  const [vector] = await embedder.embedBatch([q], "query");
  const results = await store.searchKnowledge(vector!, 3);
  const top = results[0]!;
  const hit = top.chunk.documentId === expect;
  if (hit) passed += 1;

  console.log(`  ${hit ? "PASS" : "FAIL"}  "${q}"`);
  console.log(`        -> ${top.chunk.documentId} / ${top.chunk.section}  (${top.score.toFixed(3)})`);
  if (!hit) console.log(`        !! expected ${expect}`);
}

// ---- ABSTENTION ----
// Nothing in the corpus answers this. The scores it comes back with are what
// the relevance floor has to separate from a real match.
const [offTopic] = await embedder.embedBatch(
  ["do you accept payment in bitcoin or other cryptocurrency?"],
  "query",
);
const offResults = await store.searchKnowledge(offTopic!, 3);
console.log(`\nOFF-TOPIC ("bitcoin payments" — not in corpus)`);
for (const r of offResults) {
  console.log(`  ${r.score.toFixed(3)}  ${r.chunk.documentId} / ${r.chunk.section}`);
}

console.log(`\nRESULT: ${passed}/${QUESTIONS.length} semantic matches correct`);
