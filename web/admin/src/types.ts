/**
 * Mirrors UploadedDocument in
 * packages/adapters/src/dynamodb/ingestion-state.ts, as returned by
 * `GET /admin/api/uploads` (services/admin/src/handler.ts). Kept as a plain
 * duplicate rather than a shared import — this package builds independently
 * of the backend and has no dependency on it, the same relationship the
 * storefront widget has with services/api's types.
 */
export type UploadStatus = "processing" | "ready" | "failed";

export interface UploadedDocument {
  readonly documentId: string;
  readonly status: UploadStatus;
  readonly title: string | null;
  readonly docType: string | null;
  readonly errorMessage: string | null;
  readonly s3Key: string;
  readonly uploadedAt: string;
  readonly updatedAt: string;
}
