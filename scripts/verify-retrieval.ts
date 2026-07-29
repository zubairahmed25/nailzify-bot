/**
 * Live end-to-end retrieval check.
 *
 *     npx vite-node scripts/verify-retrieval.ts
 *
 * Runs the real pipeline — chunk -> embed (Bedrock) -> index -> search — against
 * THE STORE'S ACTUAL DOCUMENTS, and prints the score distribution.
 *
 * ⚠️ IT USED TO USE THREE INVENTED DOCUMENTS. A shipping policy and a nail care
 * guide, neither of which Nailzify has, plus a returns policy that did not match
 * the real one. It reported "5/5 correct" and that number meant nothing: three of
 * the five questions targeted documents the store does not own, and the size
 * guide — which is live, and which sizing questions depend on — was never tested.
 *
 * Calibrating a relevance floor on a corpus you do not have produces a floor for
 * a corpus you do not have. It now reads data/documents/*.md.
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
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { chunkMarkdown, structuralContextHeader, embeddingText } from "@nailzify/core";
import {
  EMBEDDING_MODEL,
  createBedrockEmbedder,
  createBedrockReranker,
  createInMemoryVectorStore,
} from "@nailzify/adapters";

const DOCS_DIR = "data/documents";

/**
 * The real corpus, read from disk — the same files scripts/ingest.ts indexes.
 */
const DOCS = await Promise.all(
  (await readdir(DOCS_DIR))
    .filter((n) => extname(n) === ".md")
    .sort()
    .map(async (name) => {
      const markdown = await readFile(join(DOCS_DIR, name), "utf8");
      const id = basename(name, ".md");
      return { id, title: /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? id, markdown };
    }),
);

const embedder = createBedrockEmbedder({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  modelId: EMBEDDING_MODEL.modelId,
  dimensions: EMBEDDING_MODEL.dimensions,
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
  { q: "can I get my money back if I opened the packet?", expect: "return-policy" },
  { q: "what happens if my set turns up broken?", expect: "return-policy" },
  { q: "I'm outside the US — who pays to send them back?", expect: "return-policy" },
  { q: "how do I work out which set fits me?", expect: "size-guide" },
  { q: "my middle nail measures about 12mm, what should I order?", expect: "size-guide" },
  { q: "should I go bigger or smaller if I'm between sizes?", expect: "size-guide" },
];

/**
 * Questions with NO supporting document, kept separate from the pass/fail set.
 *
 * These are ordinary things a press-on customer asks, and the store has nothing
 * written down for any of them. The correct behaviour is abstention — but that
 * makes them invisible in a pass rate, which is exactly how a coverage gap
 * survives. Reported explicitly below so the gap is a decision, not an accident.
 */
const UNCOVERED = [
  "how long do they stay on before they fall off?",
  "what is the safest way to take them off?",
  "do you ship to the UK?",
  "how long does delivery take?",
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
const suggestedFloor = (worstCorrectRerank + bestOffRerank) / 2;
console.log(`\n  suggested rerankFloor: ${suggestedFloor.toFixed(3)}  (midpoint of the gap)`);

// A floor is only meaningful if the gap it sits in is wide enough to survive a
// question phrased slightly differently. Narrow separation means the floor is
// fitted to these exact five questions rather than to the corpus.
const margin = worstCorrectRerank - bestOffRerank;
if (margin < 0.02) {
  console.log(
    `  ⚠️ MARGIN IS ONLY ${margin.toFixed(3)}. The floor sits in a very narrow gap, so a\n` +
      `     differently-worded question could land on the wrong side of it. Treat this\n` +
      `     as provisional and widen the question set before trusting it.`,
  );
}

// ---- COVERAGE ----
//
// The part a pass rate cannot show. Every question here is one a press-on
// customer genuinely asks and the store has no document for. Abstention is the
// CORRECT response — but "correctly says I don't know" and "answers well" are
// very different customer experiences, and only one of them is a sale.
console.log(`\nCOVERAGE GAPS (no document answers these)`);
for (const q of UNCOVERED) {
  const [v] = await embedder.embedBatch([q], "query");
  const near = await store.searchKnowledge(v!, 3);
  await pace();
  const [best] = await reranker.rerank(q, near, 1);

  const score = best?.rerankScore ?? 0;
  // Above the floor means the bot will ANSWER, using a document that does not
  // actually cover the question. That is worse than abstaining: a confident
  // answer about shipping, sourced from the returns policy.
  const risk = score >= suggestedFloor ? "  <-- WOULD ANSWER ANYWAY" : "";
  console.log(
    `  "${q}"\n     best match: ${best?.chunk.documentId ?? "none"}` +
      `   rerank ${score.toFixed(3)}${risk}`,
  );
}

console.log(`\nRESULT: ${passed}/${QUESTIONS.length} semantic matches correct`);
console.log(
  `        ${UNCOVERED.length} common questions have no supporting document — ` +
    `see COVERAGE GAPS above.`,
);
