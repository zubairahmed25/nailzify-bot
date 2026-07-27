/**
 * Branded (nominal) types.
 *
 * WHY: TypeScript is structurally typed, so `type SessionId = string` gives you
 * documentation but no safety — every string is assignable to it. That matters
 * here because this system passes around a lot of identifiers that are all
 * strings and all catastrophic to mix up:
 *
 *     sendMessage(customerId, sessionId)   // compiles fine
 *     sendMessage(sessionId, customerId)   // ALSO compiles fine, and is a bug
 *
 * Branding attaches a phantom property that exists only in the type system, so
 * the two become incompatible. The runtime representation is still just a
 * string — zero cost, no wrapper object, no serialization change.
 *
 * TRADE-OFF: you need an explicit constructor at the boundary (parsing a request,
 * reading from the database). That's not overhead — that's exactly where you want
 * validation to live anyway.
 */

declare const brand: unique symbol;

/** A nominal type: `T` at runtime, distinct from `T` at compile time. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Client-generated per browser tab. Sortable UUIDv7. */
export type SessionId = Brand<string, "SessionId">;

/** Shopify customer GID, e.g. `gid://shopify/Customer/7712`. Null when logged out. */
export type CustomerId = Brand<string, "CustomerId">;

/** Shopify product GID, e.g. `gid://shopify/Product/8123`. */
export type ProductId = Brand<string, "ProductId">;

/** URL-safe product slug, e.g. `autumn-almond-short`. */
export type ProductHandle = Brand<string, "ProductHandle">;

/** Stable id for one ingested document, e.g. `returns-policy`. */
export type DocumentId = Brand<string, "DocumentId">;

/** `{documentId}#{section}#{chunk}` — deterministic, so re-ingest overwrites. */
export type ChunkId = Brand<string, "ChunkId">;

/** Client-generated, used for idempotent writes. */
export type MessageId = Brand<string, "MessageId">;

/** Milliseconds since the Unix epoch. */
export type Timestamp = Brand<number, "Timestamp">;

// ---------------------------------------------------------------------------
// Constructors
//
// These are the *only* sanctioned way into a branded type. Validation lives here
// so it happens exactly once, at the edge, rather than defensively everywhere.
// ---------------------------------------------------------------------------

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return trimmed;
}

export const SessionId = (v: string): SessionId => nonEmpty(v, "SessionId") as SessionId;
export const CustomerId = (v: string): CustomerId => nonEmpty(v, "CustomerId") as CustomerId;
export const ProductId = (v: string): ProductId => nonEmpty(v, "ProductId") as ProductId;
export const ProductHandle = (v: string): ProductHandle =>
  nonEmpty(v, "ProductHandle") as ProductHandle;
export const DocumentId = (v: string): DocumentId => nonEmpty(v, "DocumentId") as DocumentId;
export const ChunkId = (v: string): ChunkId => nonEmpty(v, "ChunkId") as ChunkId;
export const MessageId = (v: string): MessageId => nonEmpty(v, "MessageId") as MessageId;

export const Timestamp = (v: number): Timestamp => {
  if (!Number.isFinite(v) || v < 0) throw new TypeError("Timestamp must be a positive number");
  return v as Timestamp;
};

/** Build the canonical chunk id. Deterministic — see docs/03-ingestion.md §3.7. */
export const makeChunkId = (
  documentId: DocumentId,
  sectionIndex: number,
  chunkIndex: number,
): ChunkId => ChunkId(`${documentId}#s${sectionIndex}#c${chunkIndex}`);
