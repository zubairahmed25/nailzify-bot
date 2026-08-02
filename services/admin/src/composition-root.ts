/**
 * Composition root for the admin Lambda.
 *
 * Deliberately thin. This service does none of the actual work — no Bedrock,
 * no Pinecone, no PDF parsing. It hands the merchant's browser a presigned S3
 * URL and reads/writes the same `INGEST#UPLOAD` records the ingestion Lambda
 * already owns (packages/adapters/src/dynamodb/ingestion-state.ts). Extraction
 * and classification happen entirely on the other side of the S3 upload, in
 * services/ingestion, triggered by the same EventBridge rule every document
 * already relies on.
 */

import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createIngestionStateStore, type IngestionStateStore } from "@nailzify/adapters";

/**
 * Where an admin upload lands. Must stay under `raw/` — that is the prefix the
 * EventBridge rule in infra/lib/ingestion-stack.ts watches — and the basename
 * (extension stripped) becomes the document's id via `documentIdFromKey` in
 * services/ingestion/src/handler.ts. This constant and that function encode
 * the SAME convention independently; changing one without the other breaks the
 * link between an upload and the record the ingestion Lambda later updates.
 */
const UPLOAD_PREFIX = "raw/uploads/";

export interface UploadSlot {
  readonly documentId: string;
  readonly s3Key: string;
  readonly uploadUrl: string;
}

export interface AdminDeps {
  readonly state: IngestionStateStore;
  readonly sessionSecret: string;
  readonly apiKey: string;
  readonly shopDomain: string;
  /** Mints a presigned PUT URL and the document id it will resolve to. */
  createUploadSlot(filename: string): Promise<UploadSlot>;
  /** Removes the S3 object. The EventBridge ObjectRemoved rule purges its vectors. */
  deleteUploadObject(documentId: string): Promise<void>;
}

export interface AdminConfig {
  readonly region: string;
  readonly tableName: string;
  readonly documentBucket: string;
  readonly sessionSecret: string;
  readonly apiKey: string;
  readonly shopDomain: string;
  /** How long the presigned URL is valid for. Plenty of time for a browser upload. */
  readonly uploadUrlTtlSeconds?: number;
  readonly s3?: S3Client;
}

export function buildAdminDeps(config: AdminConfig): AdminDeps {
  const s3 =
    config.s3 ??
    new S3Client({
      region: config.region,
      // ⚠️ LOAD-BEARING, NOT COSMETIC. The SDK's default ("WHEN_SUPPORTED")
      // computes a CRC32 checksum at REQUEST-BUILD TIME for any operation that
      // supports one, PutObject included. A presigned URL is built with no
      // body — there is nothing yet to hash — so the default signs a checksum
      // for an EMPTY object into the URL's query string. The browser's later
      // PUT of the real, non-empty file then fails S3's checksum validation
      // with a body that never had a chance to match. Confirmed by generating
      // a presigned URL both ways and diffing the query string — the default
      // client's URL carries `x-amz-checksum-crc32=AAAAAA==` (CRC32 of
      // nothing); this one doesn't. WHEN_REQUIRED restores the pre-default
      // behaviour: only attach a checksum when the caller explicitly asks.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  const ttlSeconds = config.uploadUrlTtlSeconds ?? 300;

  const keyFor = (documentId: string): string => `${UPLOAD_PREFIX}${documentId}.pdf`;

  return {
    state: createIngestionStateStore({ tableName: config.tableName }),
    sessionSecret: config.sessionSecret,
    apiKey: config.apiKey,
    shopDomain: config.shopDomain,

    async createUploadSlot(filename) {
      const documentId = documentIdFromFilename(filename);
      const s3Key = keyFor(documentId);

      // ⚠️ NO ContentType ON THE SIGNED COMMAND, DELIBERATELY. Binding one
      // would require the browser's PUT to send back the EXACT same
      // Content-Type header or S3 rejects it with a confusing 403 — a fragile
      // coupling for no real benefit, since nothing downstream reads S3
      // object metadata. services/ingestion/src/handler.ts decides "this is a
      // PDF" from the KEY's extension alone, via GetObject, never from
      // Content-Type. Unverified against a live upload — confirm with one real
      // PUT before relying on this in production, same discipline as the App
      // Proxy HMAC note in verify-app-proxy.ts.
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: config.documentBucket, Key: s3Key }),
        { expiresIn: ttlSeconds },
      );

      return { documentId, s3Key, uploadUrl };
    },

    async deleteUploadObject(documentId) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.documentBucket, Key: keyFor(documentId) }),
      );
    },
  };
}

/**
 * `raw/uploads/return-policy.pdf` must resolve to the id `return-policy` —
 * IDENTICAL to `documentIdFromKey` in services/ingestion/src/handler.ts, or a
 * PDF uploaded through this endpoint gets one id here (`recordUploadStarted`)
 * and a different one there (`recordUploadReady` / `recordUploadFailed`),
 * leaving the admin page showing "Processing…" forever.
 *
 * Re-uploading a file with the same name is INTENTIONALLY treated as updating
 * that same document, mirroring how a re-uploaded markdown file already works
 * — "fix a typo, upload the corrected PDF" is the expected merchant workflow,
 * not a collision to guard against.
 */
function documentIdFromFilename(filename: string): string {
  const base = filename
    .replace(/^.*[/\\]/, "")
    .replace(/\.[^.]+$/, "")
    .trim();
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 120) : "document";
}
