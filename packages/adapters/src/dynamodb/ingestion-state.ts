/**
 * What the last ingestion run knew, so the next one can be incremental.
 *
 * Two questions, both answered from the existing single table:
 *
 *   PK = INGEST#DOC      SK = <documentId>   the content version last indexed
 *   PK = INGEST#PRODUCT  SK = <productId>    this product is in the index
 *
 * ============================================================================
 * WHY ONE ITEM PER PRODUCT RATHER THAN ONE LIST
 * ============================================================================
 *
 * The obvious design stores a single item holding an array of every indexed id.
 * One read, one write, less code. It also has a hard ceiling: DynamoDB items max
 * out at 400KB, and a Shopify GID is ~50 bytes, so the list breaks somewhere
 * around 8,000 products.
 *
 * That is not a theoretical limit — "scale to thousands of products" is a stated
 * requirement for this project. And the failure mode is nasty: it works fine
 * until one day an upsert throws `ValidationException: Item size has exceeded`,
 * mid-run, after the vectors are already written. The state and the index are
 * then out of step, which is exactly the condition this table exists to prevent.
 *
 * One item per product costs 40 small writes per run instead of 1. On on-demand
 * pricing that is fractions of a cent, and there is no ceiling.
 */

import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ProductId } from "@nailzify/core";

const DOC_PK = "INGEST#DOC";
const PRODUCT_PK = "INGEST#PRODUCT";

/** DynamoDB caps BatchWrite at 25 items per request. Not negotiable. */
const BATCH_LIMIT = 25;

export interface IngestionStateStore {
  /** The content version last indexed for this document, or null if never. */
  getDocumentVersion(documentId: string): Promise<string | null>;
  putDocumentVersion(documentId: string, version: string): Promise<void>;
  /**
   * Every document currently believed to be in the index.
   *
   * Needed to find orphans — vectors whose S3 object was deleted while an
   * ObjectRemoved notification was missed. An orphaned policy is worse than a
   * missing one: the bot quotes it confidently and the store no longer has it.
   */
  listIndexedDocuments(): Promise<readonly string[]>;

  listIndexedProducts(): Promise<readonly ProductId[]>;
  /** Replaces the recorded set: adds what is new, removes what is gone. */
  replaceIndexedProducts(ids: readonly ProductId[]): Promise<void>;
}

export interface IngestionStateConfig {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export function createIngestionStateStore(config: IngestionStateConfig): IngestionStateStore {
  const client =
    config.client ??
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });

  return {
    async getDocumentVersion(documentId) {
      const result = await client.send(
        new GetCommand({
          TableName: config.tableName,
          Key: { PK: DOC_PK, SK: documentId },
        }),
      );
      const version = result.Item?.["version"];
      return typeof version === "string" ? version : null;
    },

    async putDocumentVersion(documentId, version) {
      await client.send(
        new PutCommand({
          TableName: config.tableName,
          Item: {
            PK: DOC_PK,
            SK: documentId,
            version,
            indexedAt: new Date().toISOString(),
          },
        }),
      );
    },

    async listIndexedDocuments() {
      const result = await client.send(
        new QueryCommand({
          TableName: config.tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": DOC_PK },
          ProjectionExpression: "SK, version",
        }),
      );
      return (result.Items ?? [])
        // An empty version marks a document that was removed. Keeping the row
        // rather than deleting it means a redelivered S3 event is a no-op
        // instead of resurrecting a purge that already happened.
        .filter((item) => typeof item["version"] === "string" && item["version"].length > 0)
        .map((item) => String(item["SK"]));
    },

    async listIndexedProducts() {
      const ids: ProductId[] = [];
      let start: Record<string, unknown> | undefined;

      do {
        const result = await client.send(
          new QueryCommand({
            TableName: config.tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": PRODUCT_PK },
            // Only the key is needed. Projecting less is free throughput.
            ProjectionExpression: "SK",
            ExclusiveStartKey: start,
          }),
        );
        for (const item of result.Items ?? []) {
          if (typeof item["SK"] === "string") ids.push(ProductId(item["SK"]));
        }
        start = result.LastEvaluatedKey;
      } while (start);

      return ids;
    },

    async replaceIndexedProducts(ids) {
      const existing = new Set<string>(await this.listIndexedProducts());
      const wanted = new Set<string>(ids);

      const toAdd = [...wanted].filter((id) => !existing.has(id));
      const toRemove = [...existing].filter((id) => !wanted.has(id));

      const requests = [
        ...toAdd.map((id) => ({ PutRequest: { Item: { PK: PRODUCT_PK, SK: id } } })),
        ...toRemove.map((id) => ({ DeleteRequest: { Key: { PK: PRODUCT_PK, SK: id } } })),
      ];

      for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
        await writeBatchWithRetry(client, config.tableName, requests.slice(i, i + BATCH_LIMIT));
      }
    },
  };
}

/**
 * BatchWrite can partially succeed.
 *
 * ⚠️ A 200 response does NOT mean everything was written. Throttled items come
 * back in `UnprocessedItems`, and code that ignores that field silently loses
 * writes under exactly the load where losing them matters most. Retrying the
 * unprocessed remainder with backoff is mandatory, not defensive.
 */
async function writeBatchWithRetry(
  client: DynamoDBDocumentClient,
  tableName: string,
  requests: object[],
  attempt = 0,
): Promise<void> {
  if (requests.length === 0) return;

  const result = await client.send(
    new BatchWriteCommand({ RequestItems: { [tableName]: requests as never } }),
  );

  const unprocessed = result.UnprocessedItems?.[tableName] ?? [];
  if (unprocessed.length === 0) return;

  if (attempt >= 5) {
    throw new Error(
      `DynamoDB left ${unprocessed.length} ingestion-state writes unprocessed after ` +
        `6 attempts. The vector index and this table are now out of step — rerun ingestion.`,
    );
  }

  // Exponential backoff with jitter. Without jitter, every retrying client wakes
  // at the same instant and re-throttles itself in lockstep.
  const delayMs = 2 ** attempt * 50 + Math.random() * 50;
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  await writeBatchWithRetry(client, tableName, unprocessed as object[], attempt + 1);
}
