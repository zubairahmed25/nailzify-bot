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
import {
  createBedrockEmbedder,
  createBedrockReranker,
  createInMemoryVectorStore,
} from "@nailzify/adapters";

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
const reranker = createBedrockReranker({ region: "us-east-1", maxAttempts: 8 });
const store = createInMemoryVectorStore();

/**
 * Pace between rerank calls.
 *
 * On-demand throughput for cohere.rerank-v3-5:0 is tight enough that three
 * back-to-back calls throttle. This script is a measurement tool, not a load
 * test, so it waits rather than fighting the limit.
 */
const PACE_MS = 4_000;
const pace = () => new Promise((r) => setTimeout(r, PACE_MS));

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

console.log("SEARCH  (cosine -> rerank)");
let passed = 0;
const correctCosine: number[] = [];
const correctRerank: number[] = [];

for (const { q, expect } of QUESTIONS) {
  const [vector] = await embedder.embedBatch([q], "query");
  // Retrieve wide, then let the cross-encoder narrow. Setting topK generously
  // costs little and gives the reranker something to work with.
  const candidates = await store.searchKnowledge(vector!, 6);
  await pace();
  const reranked = await reranker.rerank(q, candidates, 3);

  const top = reranked[0]!;
  const hit = top.chunk.documentId === expect;
  if (hit) {
    passed += 1;
    correctCosine.push(top.score);
    correctRerank.push(top.rerankScore!);
  }

  console.log(`  ${hit ? "PASS" : "FAIL"}  "${q}"`);
  console.log(
    `        -> ${top.chunk.documentId} / ${top.chunk.section}` +
      `   cosine ${top.score.toFixed(3)}  rerank ${top.rerankScore!.toFixed(3)}`,
  );
  if (!hit) console.log(`        !! expected ${expect}`);
}

// ---- ABSTENTION ----
// Nothing in the corpus answers this. Whatever scores come back are what the
// relevance floor has to separate from a genuine match — the whole reason this
// script exists.
const OFF_TOPIC = "do you accept payment in bitcoin or other cryptocurrency?";
const [offVector] = await embedder.embedBatch([OFF_TOPIC], "query");
const offCandidates = await store.searchKnowledge(offVector!, 6);
await pace();
const offReranked = await reranker.rerank(OFF_TOPIC, offCandidates, 3);

console.log(`\nOFF-TOPIC ("bitcoin payments" — not in corpus)`);
for (const r of offReranked) {
  console.log(
    `  cosine ${r.score.toFixed(3)}  rerank ${r.rerankScore!.toFixed(3)}   ` +
      `${r.chunk.documentId} / ${r.chunk.section}`,
  );
}

// ---- CALIBRATION ----
// This block is the point of the whole script: it produces the numbers that
// belong in DEFAULT_RETRIEVAL_POLICY. Do not hand-pick thresholds; read them
// off here and re-run whenever the embedding or rerank model changes.
const worstCorrectCosine = Math.min(...correctCosine);
const worstCorrectRerank = Math.min(...correctRerank);
const bestOffCosine = Math.max(...offReranked.map((r) => r.score));
const bestOffRerank = Math.max(...offReranked.map((r) => r.rerankScore!));

const ratio = (good: number, bad: number) => (bad === 0 ? Infinity : good / bad);

console.log(`\nCALIBRATION`);
console.log(`                  worst correct   best off-topic   separation`);
console.log(
  `  cosine          ${worstCorrectCosine.toFixed(3).padStart(13)}   ` +
    `${bestOffCosine.toFixed(3).padStart(14)}   ` +
    `${ratio(worstCorrectCosine, bestOffCosine).toFixed(2)}x`,
);
console.log(
  `  rerank          ${worstCorrectRerank.toFixed(3).padStart(13)}   ` +
    `${bestOffRerank.toFixed(3).padStart(14)}   ` +
    `${ratio(worstCorrectRerank, bestOffRerank).toFixed(2)}x`,
);
console.log(
  `\n  suggested rerankFloor: ${((worstCorrectRerank + bestOffRerank) / 2).toFixed(3)}` +
    `  (midpoint of the gap)`,
);

console.log(`\nRESULT: ${passed}/${QUESTIONS.length} semantic matches correct`);
