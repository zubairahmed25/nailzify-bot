/**
 * Lambda entry point for ingestion.
 *
 * Thin on purpose: resolve configuration, build the container once, delegate.
 * Everything worth testing lives in `handler.ts`, which takes its dependencies
 * as an argument and needs no AWS account to exercise.
 *
 * CDK points the function's handler at `lambda.handler`.
 */

import { createSecretsManagerProvider } from "@nailzify/adapters";
import { buildIngestionDeps, type IngestionConfig, type IngestionDeps } from "./composition-root.js";
import { handleIngestion, type IngestionEvent, type IngestionResult } from "./handler.js";

/**
 * Built once per execution context, reused across warm invocations.
 *
 * The scheduled product sync runs daily, so most invocations are cold and this
 * saves little there. It matters for the S3-triggered path, where uploading
 * several documents at once produces a burst of invocations into one container.
 */
let deps: IngestionDeps | undefined;

async function getDeps(): Promise<IngestionDeps> {
  if (deps) return deps;
  deps = buildIngestionDeps(await loadConfig());
  return deps;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at cold start, loudly, naming the variable. A half-configured
    // container that fails partway through is strictly worse: it can delete
    // vectors and then be unable to write their replacements.
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function loadConfig(): Promise<IngestionConfig> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const secrets = createSecretsManagerProvider({ region });

  // Fetched in parallel. Sequential awaits would add ~60ms to every cold start
  // for two calls that have nothing to do with each other.
  const [pineconeApiKey, storefrontToken] = await Promise.all([
    secrets.get(required("PINECONE_SECRET_ARN")),
    secrets.get(required("STOREFRONT_SECRET_ARN")),
  ]);

  return {
    region,
    tableName: required("TABLE_NAME"),
    documentBucket: required("DOCUMENT_BUCKET"),
    documentPrefix: process.env["DOCUMENT_PREFIX"] ?? "",
    pineconeApiKey,
    pineconeIndex: required("PINECONE_INDEX"),
    shopDomain: required("SHOP_DOMAIN"),
    storefrontDomain: required("STOREFRONT_DOMAIN"),
    storefrontToken,
    shopifyApiVersion: required("SHOPIFY_API_VERSION"),
  };
}

export async function handler(event: IngestionEvent): Promise<IngestionResult> {
  const result = await handleIngestion(event, await getDeps());

  // One structured line per run. CloudWatch Logs Insights can query these
  // directly, and it is the only visibility this job has — nobody is watching a
  // 03:00 cron.
  console.log(
    JSON.stringify({
      level: "INFO",
      msg: "ingestion.complete",
      documents: result.documents,
      products: result.products,
      warningCount: result.warnings.length,
    }),
  );

  // Warnings are merchandising problems, not failures. Logged separately at WARN
  // so an alarm can be set on them without alarming on every successful run.
  for (const warning of result.warnings) {
    console.warn(JSON.stringify({ level: "WARN", msg: "merchandising", detail: warning }));
  }

  return result;
}
