/**
 * Composition root for the ingestion Lambda.
 *
 * The one place this service names concrete infrastructure. `handler.ts` and all
 * of `packages/core` take ports and cannot tell whether they are talking to S3
 * or a local directory — which is what makes the handler unit-testable without
 * an AWS account.
 *
 * Takes RESOLVED values, exactly like the API service's `buildContainer`. Secret
 * fetching is asynchronous and belongs to the entry point; a synchronous builder
 * keeps every consumer, including tests, from having to await construction.
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  EMBEDDING_MODEL,
  createBedrockEmbedder,
  createIngestionStateStore,
  createPineconeVectorStore,
  createShopifyProductCatalog,
  createStorefrontClient,
  type IngestionStateStore,
} from "@nailzify/adapters";
import type { Embedder, ProductCatalog, VectorStore } from "@nailzify/core";

export interface DocumentSource {
  /** Every ingestible key under the configured prefix. */
  list(): Promise<readonly string[]>;
  read(bucket: string, key: string): Promise<string>;
}

export interface IngestionDeps {
  readonly embedder: Embedder;
  readonly vectors: VectorStore;
  readonly catalog: ProductCatalog;
  readonly state: IngestionStateStore;
  readonly documents: DocumentSource;
  readonly documentBucket: string;
  /**
   * Merchandising warnings collected during this invocation.
   *
   * The Shopify adapter takes `onWarning` at CONSTRUCTION — here — so the
   * handler cannot supply one. It drains instead. Draining rather than reading a
   * live array makes the reset explicit: a warm container serves many
   * invocations, and last invocation's warnings must not be reported as this
   * one's.
   */
  drainWarnings(): readonly string[];
}

export interface IngestionConfig {
  readonly region: string;
  readonly tableName: string;
  readonly documentBucket: string;
  readonly documentPrefix?: string;
  readonly pineconeApiKey: string;
  readonly pineconeIndex: string;
  readonly shopDomain: string;
  readonly storefrontDomain: string;
  readonly storefrontToken: string;
  readonly shopifyApiVersion: string;
  readonly s3?: S3Client;
}

export function buildIngestionDeps(config: IngestionConfig): IngestionDeps {
  const s3 = config.s3 ?? new S3Client({ region: config.region });
  const prefix = config.documentPrefix ?? "";

  let warnings: string[] = [];

  // Model and dimension come from one shared constant. Ingestion and query MUST
  // agree exactly — vectors from different models are not comparable, and the
  // failure is a bot that finds nothing rather than an error anyone can see.
  const embedder = createBedrockEmbedder({
    region: config.region,
    modelId: EMBEDDING_MODEL.modelId,
    dimensions: EMBEDDING_MODEL.dimensions,
  });

  const catalog = createShopifyProductCatalog({
    client: createStorefrontClient({
      shopDomain: config.shopDomain,
      accessToken: config.storefrontToken,
      apiVersion: config.shopifyApiVersion,
    }),
    storefrontDomain: config.storefrontDomain,
    onWarning: (w) => warnings.push(w),
  });

  const documents: DocumentSource = {
    async list() {
      const keys: string[] = [];
      let token: string | undefined;

      // Paginated. ListObjectsV2 returns at most 1000 keys and silently
      // truncates — reading only the first page works until the 1001st document,
      // then quietly stops indexing anything past it.
      do {
        const result = await s3.send(
          new ListObjectsV2Command({
            Bucket: config.documentBucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const object of result.Contents ?? []) {
          // A console-created "folder" is a zero-byte key ending in "/".
          if (object.Key && !object.Key.endsWith("/")) keys.push(object.Key);
        }
        token = result.NextContinuationToken;
      } while (token);

      return keys;
    },

    async read(bucket, key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error(`S3 object ${bucket}/${key} returned no body.`);
      return result.Body.transformToString("utf-8");
    },
  };

  return {
    embedder,
    catalog,
    documents,
    documentBucket: config.documentBucket,
    vectors: createPineconeVectorStore({
      apiKey: config.pineconeApiKey,
      indexName: config.pineconeIndex,
    }),
    state: createIngestionStateStore({ tableName: config.tableName }),
    drainWarnings() {
      const collected = warnings;
      warnings = [];
      return collected;
    },
  };
}
