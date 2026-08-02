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
  createBedrockLlmClient,
  createIngestionStateStore,
  createPdfExtractor,
  createPineconeVectorStore,
  createShopifyProductCatalog,
  createStorefrontClient,
  type IngestionStateStore,
} from "@nailzify/adapters";
import type { Embedder, LlmClient, PdfExtractor, ProductCatalog, VectorStore } from "@nailzify/core";

export interface DocumentSource {
  /** Every ingestible key under the configured prefix. */
  list(): Promise<readonly string[]>;
  /** Text files (markdown, txt) — decoded as UTF-8. */
  read(bucket: string, key: string): Promise<string>;
  /**
   * Binary files (PDF) — the raw bytes, undecoded.
   *
   * A separate method rather than an option on `read()` because decoding a PDF
   * as UTF-8 text corrupts it — this is not "the same operation with a flag",
   * it is a different operation that happens to share a bucket.
   */
  readBytes(bucket: string, key: string): Promise<Uint8Array>;
}

export interface IngestionDeps {
  readonly embedder: Embedder;
  readonly vectors: VectorStore;
  readonly catalog: ProductCatalog;
  readonly state: IngestionStateStore;
  readonly documents: DocumentSource;
  readonly documentBucket: string;
  /** Classifies an uploaded PDF's title, category and section headings. */
  readonly llm: LlmClient;
  readonly pdfExtractor: PdfExtractor;
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
  /**
   * Same model IDs the chat Lambda uses — `judge` resolves to the same model as
   * `chat` in both DEFAULT_MODELS and FALLBACK_MODELS today, so there is no
   * separate "judge model" config to invent. This Lambda only ever requests
   * `model: "judge"` (document classification); `chat` and `fast` are supplied
   * purely because ModelRoleMap requires the full shape.
   */
  readonly chatModelId: string;
  readonly fastModelId: string;
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

    async readBytes(bucket, key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error(`S3 object ${bucket}/${key} returned no body.`);
      return result.Body.transformToByteArray();
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
    // See the note on IngestionConfig.chatModelId — judge deliberately mirrors
    // chat, since that is the same equivalence the chat Lambda's own model maps
    // already encode.
    llm: createBedrockLlmClient({
      region: config.region,
      models: { chat: config.chatModelId, fast: config.fastModelId, judge: config.chatModelId },
    }),
    pdfExtractor: createPdfExtractor(),
    drainWarnings() {
      const collected = warnings;
      warnings = [];
      return collected;
    },
  };
}
