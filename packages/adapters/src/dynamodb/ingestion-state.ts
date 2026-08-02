/**
 * What the last ingestion run knew, so the next one can be incremental.
 *
 * Three questions, all answered from the existing single table:
 *
 *   PK = INGEST#DOC      SK = <documentId>   the content version last indexed
 *   PK = INGEST#PRODUCT  SK = <productId>    this product is in the index
 *   PK = INGEST#UPLOAD   SK = <documentId>   status of an admin-uploaded PDF
 *
 * ============================================================================
 * WHY UPLOAD STATUS IS A SEPARATE RECORD FROM THE VERSION RECORD
 * ============================================================================
 *
 * `INGEST#DOC` answers one question — "has this changed since last time?" —
 * for the ingestion pipeline's own skip-logic. It has exactly one writer (the
 * ingestion Lambda, after a successful run) and one reader (the same Lambda,
 * next run).
 *
 * `INGEST#UPLOAD` answers a different question — "what is a human looking at
 * the admin page allowed to believe is true right now?" — and has TWO writers
 * at TWO different times: the upload endpoint writes `processing` the instant
 * a PDF lands in S3, before ingestion has even started; the ingestion Lambda
 * writes `ready` or `failed` seconds later, once it actually knows. Folding
 * this into the version record would mean the admin page reading a document's
 * "current" title from a record that a concurrent write is still assembling.
 * Two records, two lifecycles, no ambiguity about which write is allowed to
 * clobber which field.
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
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ProductId, type DocType } from "@nailzify/core";

const DOC_PK = "INGEST#DOC";
const PRODUCT_PK = "INGEST#PRODUCT";
const UPLOAD_PK = "INGEST#UPLOAD";

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

  // ---------------------------------------------------------------------
  // Admin-uploaded PDFs — what the admin page is allowed to show
  // ---------------------------------------------------------------------

  /**
   * The upload endpoint calls this the instant a PDF lands in S3 — before
   * ingestion has even started. Gives the admin page something honest to show
   * ("Processing…") the moment the merchant hits upload, rather than a blank
   * row until the Lambda gets around to it.
   *
   * `title` is the merchant's own "Purpose" text (services/admin), not
   * something Claude derived — it is known upfront, correct by construction,
   * and never blank while classification is still running. See
   * getUploadTitle for why the ingestion Lambda needs to read it back.
   */
  recordUploadStarted(input: { documentId: string; s3Key: string; title: string }): Promise<void>;

  /**
   * The title a merchant gave THIS upload at the moment they started it —
   * read back by the ingestion Lambda's classification step, which no longer
   * asks the model for a title at all (packages/core/src/application/
   * classify-document.ts). Null only for a PDF that landed under `raw/`
   * outside the admin upload endpoint (a manual console upload, a migration
   * script) and so never went through recordUploadStarted — genuinely rare,
   * and the caller falls back to the document id itself, the same "?? id"
   * pattern markdown documents already use when they have no title heading.
   */
  getUploadTitle(documentId: string): Promise<string | null>;

  /**
   * The ingestion Lambda calls this once extraction, classification and
   * embedding have all succeeded. `docType` is what Claude detected from the
   * PDF's own text; the title was already set by recordUploadStarted and
   * does not change here.
   */
  recordUploadReady(input: { documentId: string; docType: DocType }): Promise<void>;

  /**
   * The ingestion Lambda calls this when a re-uploaded file's content hash
   * matches what's already indexed — the classification skip path in
   * services/ingestion/src/handler.ts's `ingestPdf`, which deliberately never
   * re-runs Claude for content it has already seen. Nothing to write except
   * flipping status back — the title/docType already sitting in the row are
   * still correct.
   */
  recordUploadUnchanged(documentId: string): Promise<void>;

  /**
   * The ingestion Lambda calls this if any step failed. `errorMessage` reaches
   * the admin page verbatim, so keep it something a merchant can act on
   * ("couldn't read any text from this PDF — is it a scanned image?") rather
   * than a stack trace.
   */
  recordUploadFailed(input: { documentId: string; errorMessage: string }): Promise<void>;

  /** Called when a merchant deletes an upload, alongside removing it from S3. */
  deleteUploadRecord(documentId: string): Promise<void>;

  /** Most recent first — the order a merchant expects their upload list in. */
  listUploadedDocuments(): Promise<readonly UploadedDocument[]>;
}

export type UploadStatus = "processing" | "ready" | "failed";

export interface UploadedDocument {
  readonly documentId: string;
  readonly status: UploadStatus;
  /**
   * The merchant's "Purpose" text, set the instant upload starts — never
   * null for anything uploaded through the admin page, "processing" included.
   */
  readonly title: string | null;
  readonly docType: DocType | null;
  /** Set only when `status === "failed"`. */
  readonly errorMessage: string | null;
  readonly s3Key: string;
  readonly uploadedAt: string;
  readonly updatedAt: string;
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

    async recordUploadStarted({ documentId, s3Key, title }) {
      const now = new Date().toISOString();
      await client.send(
        new UpdateCommand({
          TableName: config.tableName,
          Key: { PK: UPLOAD_PK, SK: documentId },
          // UpdateCommand, not PutCommand: a re-upload (same merchant "Purpose",
          // possibly changed file content) must not silently erase docType if
          // this ever raced with recordUploadReady — SET makes that harmless
          // rather than merely unlikely. `title` IS overwritten unconditionally
          // here, unlike docType/errorMessage below — it comes from the
          // merchant's own input on THIS request, not from something an
          // earlier classification run determined, so there is nothing stale
          // about replacing it.
          UpdateExpression:
            "SET #status = :status, s3Key = :s3Key, title = :title, " +
            "uploadedAt = :now, updatedAt = :now, GSI2PK = :pk, GSI2SK = :gsi2sk, " +
            "docType = if_not_exists(docType, :null), " +
            "errorMessage = if_not_exists(errorMessage, :null)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "processing" satisfies UploadStatus,
            ":s3Key": s3Key,
            ":title": title,
            ":now": now,
            // Mirrored onto GSI2 — its OWN index, not GSI1, after discovering
            // live that DynamoDB cannot widen an existing GSI's projection
            // (infra/lib/data-stack.ts) — so the admin page can list uploads
            // newest-first without a table scan. GSI2PK is a constant, not
            // per-document, precisely so ONE query returns all of them —
            // sorting happens for free via GSI2SK, which leads with the
            // timestamp. Fine at "a company's own documents" scale (dozens to
            // low hundreds); a single hot partition would need revisiting long
            // before that, at a volume nothing here is designed for.
            ":pk": UPLOAD_PK,
            ":gsi2sk": `${now}#${documentId}`,
            ":null": null,
          },
        }),
      );
    },

    async getUploadTitle(documentId) {
      const result = await client.send(
        new GetCommand({
          TableName: config.tableName,
          Key: { PK: UPLOAD_PK, SK: documentId },
          ProjectionExpression: "title",
        }),
      );
      const title = result.Item?.["title"];
      return typeof title === "string" && title.length > 0 ? title : null;
    },

    async recordUploadUnchanged(documentId) {
      await client.send(
        new UpdateCommand({
          TableName: config.tableName,
          Key: { PK: UPLOAD_PK, SK: documentId },
          UpdateExpression: "SET #status = :status, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "ready" satisfies UploadStatus,
            ":now": new Date().toISOString(),
          },
        }),
      );
    },

    async recordUploadReady({ documentId, docType }) {
      await client.send(
        new UpdateCommand({
          TableName: config.tableName,
          Key: { PK: UPLOAD_PK, SK: documentId },
          // SET only the fields this write actually knows about. A full PutItem
          // would silently erase uploadedAt/s3Key/GSI2SK if this ever ran before
          // recordUploadStarted — an ordering that should not happen, but SET
          // makes it harmless rather than merely unlikely. title is NOT set
          // here — recordUploadStarted already set it from the merchant's
          // "Purpose" input, and this write has no fresher value to offer.
          UpdateExpression:
            "SET #status = :status, docType = :docType, errorMessage = :noError, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "ready" satisfies UploadStatus,
            ":docType": docType,
            ":noError": null,
            ":now": new Date().toISOString(),
          },
        }),
      );
    },

    async recordUploadFailed({ documentId, errorMessage }) {
      await client.send(
        new UpdateCommand({
          TableName: config.tableName,
          Key: { PK: UPLOAD_PK, SK: documentId },
          UpdateExpression: "SET #status = :status, errorMessage = :error, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "failed" satisfies UploadStatus,
            ":error": errorMessage,
            ":now": new Date().toISOString(),
          },
        }),
      );
    },

    async deleteUploadRecord(documentId) {
      await client.send(
        new DeleteCommand({
          TableName: config.tableName,
          Key: { PK: UPLOAD_PK, SK: documentId },
        }),
      );
    },

    async listUploadedDocuments() {
      const items: UploadedDocument[] = [];
      let start: Record<string, unknown> | undefined;

      do {
        const result = await client.send(
          new QueryCommand({
            TableName: config.tableName,
            IndexName: "GSI2",
            KeyConditionExpression: "GSI2PK = :pk",
            ExpressionAttributeValues: { ":pk": UPLOAD_PK },
            // Newest first. GSI2SK leads with an ISO timestamp, so descending
            // order on the sort key IS newest-first — no separate sort needed.
            ScanIndexForward: false,
            ExclusiveStartKey: start,
          }),
        );
        for (const item of result.Items ?? []) items.push(toUploadedDocument(item));
        start = result.LastEvaluatedKey;
      } while (start);

      return items;
    },
  };
}

const KNOWN_STATUSES: readonly UploadStatus[] = ["processing", "ready", "failed"];

function toUploadedDocument(item: Record<string, unknown>): UploadedDocument {
  const str = (key: string): string | null =>
    typeof item[key] === "string" ? (item[key] as string) : null;

  const rawStatus = str("status");

  return {
    documentId: String(item["SK"]),
    // Falls back to "processing" for BOTH a missing status and a value that is
    // not one of the three this code knows about — the second case matters
    // more than it looks. A future deploy that adds a new status value must
    // not make every OLDER admin page reading this table throw on an item it
    // doesn't recognise; a display bug for one row beats the whole list
    // failing to load.
    status: (KNOWN_STATUSES as readonly string[]).includes(rawStatus ?? "")
      ? (rawStatus as UploadStatus)
      : "processing",
    title: str("title"),
    docType: str("docType") as UploadedDocument["docType"],
    errorMessage: str("errorMessage"),
    s3Key: str("s3Key") ?? "",
    uploadedAt: str("uploadedAt") ?? "",
    updatedAt: str("updatedAt") ?? "",
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
