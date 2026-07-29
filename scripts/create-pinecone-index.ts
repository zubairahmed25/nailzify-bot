/**
 * Create the Pinecone index, with the dimension taken from the embedder itself.
 *
 *     PINECONE_API_KEY=... npx vite-node scripts/create-pinecone-index.ts
 *     PINECONE_API_KEY=... npx vite-node scripts/create-pinecone-index.ts --env prod
 *
 * ============================================================================
 * WHY THIS IS A SCRIPT AND NOT A CONSOLE CLICK-THROUGH
 * ============================================================================
 *
 * The index dimension has to match the embedding model EXACTLY, and the number
 * is not the one the model's documentation leads with. Cohere embed-v4 returns
 * 1536 by default; this project pins `output_dimension: 1024`. Create a 1536
 * index from the docs and every upsert fails; create 1024 but forget the pin and
 * every upsert fails the other way.
 *
 * Worse, the dimension is IMMUTABLE. Getting it wrong means deleting the index
 * and re-embedding the corpus — after a confusing error that names neither the
 * model nor the pin.
 *
 * So the number is not typed here at all. It is read from EMBEDDING_MODEL, the
 * same constant the ingestion and query paths use. The three can no longer
 * disagree, which is the entire point.
 *
 * ============================================================================
 * WHY IT DOES NOT CREATE NAMESPACES
 * ============================================================================
 *
 * Pinecone namespaces are not resources — they spring into existence on first
 * upsert and vanish when empty. "knowledge" and "products" appear when ingestion
 * runs. There is nothing to provision.
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { EMBEDDING_MODEL } from "@nailzify/adapters";

const args = process.argv.slice(2);
const envName = args[args.indexOf("--env") + 1] ?? "dev";
const indexName = `nailzify-${envName}`;

const apiKey = process.env["PINECONE_API_KEY"];
if (!apiKey) {
  console.error(
    "\nMissing PINECONE_API_KEY.\n\n" +
      "  Pinecone console -> API Keys -> copy the value\n" +
      "  export PINECONE_API_KEY=<key>\n",
  );
  process.exit(1);
}

// Co-located with the Lambda. A cross-region vector query adds ~30ms to every
// single customer message, which is the kind of latency nobody ever goes back
// and finds.
const REGION = "us-east-1";

const pinecone = new Pinecone({ apiKey });

console.log(`Index      ${indexName}`);
console.log(`Dimension  ${EMBEDDING_MODEL.dimensions}   (from EMBEDDING_MODEL, not typed here)`);
console.log(`Model      ${EMBEDDING_MODEL.modelId}`);
console.log(`Metric     cosine`);
console.log(`Region     aws / ${REGION}\n`);

const existing = await pinecone.listIndexes();
const match = existing.indexes?.find((i) => i.name === indexName);

if (match) {
  // Idempotent: re-running is safe. But an existing index with the WRONG
  // dimension is the failure this script exists to prevent, so say so loudly
  // rather than reporting a cheerful "already exists".
  if (match.dimension !== EMBEDDING_MODEL.dimensions) {
    console.error(
      `MISMATCH — "${indexName}" exists with dimension ${match.dimension}, but the\n` +
        `embedder produces ${EMBEDDING_MODEL.dimensions}.\n\n` +
        `Dimension is immutable. Every upsert against this index will fail.\n` +
        `Delete it and rerun this script:\n\n` +
        `  await pinecone.deleteIndex("${indexName}")\n\n` +
        `⚠️ Deleting discards every vector in it — rerun scripts/ingest.ts afterwards.\n`,
    );
    process.exit(1);
  }

  console.log(`Already exists with the correct dimension. Nothing to do.`);
  process.exit(0);
}

await pinecone.createIndex({
  name: indexName,
  dimension: EMBEDDING_MODEL.dimensions,
  // Cosine, because these are semantic-similarity vectors where only direction
  // carries meaning. Euclidean would let vector magnitude — an artifact of text
  // length, not of relevance — influence the ranking.
  metric: "cosine",
  spec: { serverless: { cloud: "aws", region: REGION } },
  // Blocks until the index is queryable. Returning early means the very next
  // command (an ingest run) races a still-initialising index.
  waitUntilReady: true,
});

console.log(`\nCreated. Next:\n`);
console.log(`  export PINECONE_INDEX=${indexName}`);
console.log(`  npx vite-node scripts/ingest.ts`);
