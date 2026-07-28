/**
 * DynamoDB implementation of `ConversationRepository`.
 *
 * Single-table design (docs/06-data-model.md). The schema is derived from access
 * patterns, not from entities:
 *
 *   PK = SESSION#<id>   SK = META                      session metadata
 *   PK = SESSION#<id>   SK = MSG#<padded ts>#<msgId>   one message
 *
 * Co-locating messages under the session's partition key means loading a
 * conversation is ONE query, not a join and not N round trips. That is the whole
 * reason the keys look like this.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CustomerId,
  MessageId,
  RepositoryCorruption,
  SessionId,
  type ConversationRepository,
  type Message,
  type Session,
} from "@nailzify/core";

export interface DynamoConversationRepoConfig {
  readonly tableName: string;
  readonly region?: string;
  readonly client?: DynamoDBDocumentClient;
  /** Days a conversation is retained. Also a data-minimisation control. */
  readonly retentionDays?: number;
}

/** Thrown when a conditional write loses a race. Callers should reload and retry. */
export class ConcurrentSessionUpdate extends Error {
  readonly code = "CONCURRENT_SESSION_UPDATE";
}

const SESSION_PK = (id: string) => `SESSION#${id}`;
const META_SK = "META";

/**
 * Sort key: time-ordered AND deterministic per message.
 *
 * The timestamp is zero-padded because DynamoDB sorts sort keys
 * LEXICOGRAPHICALLY, not numerically — unpadded, "9999" sorts after "10000" and
 * the conversation comes back scrambled. 15 digits covers well past year 2286.
 *
 * Appending messageId makes the key deterministic, which is what gives us
 * idempotency: a double-clicked send writes the same key twice and the
 * conditional put makes the second a no-op.
 */
const MESSAGE_SK = (createdAt: number, messageId: string) =>
  `MSG#${String(createdAt).padStart(15, "0")}#${messageId}`;

export function createDynamoConversationRepo(
  config: DynamoConversationRepoConfig,
): ConversationRepository {
  const doc =
    config.client ??
    DynamoDBDocumentClient.from(
      new DynamoDBClient(config.region ? { region: config.region } : {}),
      {
        marshallOptions: {
          // Domain objects use optional fields. Without this, an absent
          // `citations` marshals to a DynamoDB NULL rather than being omitted,
          // and reads back as null instead of undefined.
          removeUndefinedValues: true,
        },
      },
    );

  const table = config.tableName;
  const retentionDays = config.retentionDays ?? 30;

  return {
    async loadSession(id) {
      const result = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { PK: SESSION_PK(id), SK: META_SK },
          // Turn N must see turn N-1. An eventually-consistent read can miss the
          // write from moments ago and the bot appears to forget the message the
          // customer just sent. Doubles the read cost — fractions of a cent.
          ConsistentRead: true,
        }),
      );
      return result.Item ? toSession(result.Item) : null;
    },

    async createSession(session) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: toSessionItem(session, retentionDays),
          // Fail rather than silently clobber a session created by a concurrent
          // request for the same id.
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    },

    async saveSession(session, expectedVersion) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: toSessionItem(session, retentionDays),
            // Optimistic concurrency. Two browser tabs posting at once would
            // otherwise interleave turns into nonsense — rare, but genuinely
            // confusing when it happens.
            ConditionExpression: "attribute_not_exists(PK) OR version = :expected",
            ExpressionAttributeValues: { ":expected": expectedVersion },
          }),
        );
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          throw new ConcurrentSessionUpdate(
            `Session ${session.id} changed since version ${expectedVersion}`,
          );
        }
        throw error;
      }
    },

    async loadRecentMessages(id, limit) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": SESSION_PK(id), ":prefix": "MSG#" },
          // Newest first so `Limit` takes the most RECENT messages. Querying
          // ascending with a limit would return the OLDEST — the exact opposite
          // of what a conversation window needs.
          ScanIndexForward: false,
          Limit: limit,
          ConsistentRead: true,
        }),
      );

      // Flip back to chronological for the model.
      return (result.Items ?? []).reverse().map(toMessage);
    },

    async appendMessages(id, messages, ttlEpochSeconds) {
      if (messages.length === 0) return;

      // Individual conditional puts rather than a transaction. A transaction
      // would fail wholesale if ONE message already existed, so a partial retry
      // could never complete. Here an already-written message is simply a no-op
      // and the rest still land.
      await Promise.all(
        messages.map(async (message) => {
          try {
            await doc.send(
              new PutCommand({
                TableName: table,
                Item: toMessageItem(id, message, ttlEpochSeconds),
                ConditionExpression: "attribute_not_exists(SK)",
              }),
            );
          } catch (error) {
            // Idempotency: a duplicate send (double click, client retry) is a
            // success, not an error.
            if (!isConditionalCheckFailure(error)) throw error;
          }
        }),
      );
    },

    async findSessionsByCustomer(customerId) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `CUSTOMER#${customerId}` },
          // A GSI is a separate copy of the data and is ALWAYS eventually
          // consistent — ConsistentRead is not permitted here. Fine: this backs
          // a deletion/export request, not the request path.
          ScanIndexForward: false,
        }),
      );

      return (result.Items ?? [])
        .map((item) => item["sessionId"])
        .filter((v): v is string => typeof v === "string")
        .map(SessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Domain -> item
// ---------------------------------------------------------------------------

function toSessionItem(session: Session, retentionDays: number): Record<string, unknown> {
  return {
    PK: SESSION_PK(session.id),
    SK: META_SK,
    entityType: "Session",
    sessionId: session.id,
    customerId: session.customerId,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    turnCount: session.turnCount,
    tokensUsed: session.tokensUsed,
    summary: session.summary,
    escalated: session.escalated,
    version: session.version,
    // ⚠️ EPOCH SECONDS. DynamoDB TTL silently ignores millisecond values —
    // they parse as a date ~50,000 years out, so retention quietly never
    // happens and customer messages accumulate forever.
    expiresAt: Math.floor(session.lastActiveAt / 1000) + retentionDays * 86_400,
    // GSI1 backs "every session for this customer", which is how a deletion
    // request is serviced. Only present when signed in.
    ...(session.customerId
      ? {
          GSI1PK: `CUSTOMER#${session.customerId}`,
          GSI1SK: `SESSION#${new Date(session.createdAt).toISOString()}`,
        }
      : {}),
  };
}

function toMessageItem(
  sessionId: string,
  message: Message,
  ttlEpochSeconds: number,
): Record<string, unknown> {
  return {
    PK: SESSION_PK(sessionId),
    SK: MESSAGE_SK(message.createdAt, message.id),
    entityType: "Message",
    messageId: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    // Provenance. `retrievedChunkIds` is the highest-value debugging attribute
    // in the schema: when a customer reports a wrong answer, it reconstructs
    // exactly what the model was shown.
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    citations: message.citations,
    retrievedChunkIds: message.retrievedChunkIds,
    shownProductIds: message.shownProductIds,
    usage: message.usage,
    promptVersion: message.promptVersion,
    expiresAt: ttlEpochSeconds,
  };
}

// ---------------------------------------------------------------------------
// Item -> domain
// ---------------------------------------------------------------------------

function toSession(item: Record<string, unknown>): Session {
  const sessionId = str(item, "sessionId");
  if (!sessionId) throw new RepositoryCorruption("Session item is missing sessionId");

  const customerId = item["customerId"];

  return {
    id: SessionId(sessionId),
    customerId: typeof customerId === "string" && customerId ? CustomerId(customerId) : null,
    createdAt: num(item, "createdAt"),
    lastActiveAt: num(item, "lastActiveAt"),
    turnCount: num(item, "turnCount"),
    tokensUsed: num(item, "tokensUsed"),
    summary: typeof item["summary"] === "string" ? item["summary"] : null,
    escalated: item["escalated"] === true,
    version: num(item, "version"),
  };
}

function toMessage(item: Record<string, unknown>): Message {
  const messageId = str(item, "messageId");
  const role = str(item, "role");
  if (!messageId) throw new RepositoryCorruption("Message item is missing messageId");
  if (role !== "user" && role !== "assistant") {
    throw new RepositoryCorruption(`Message ${messageId} has invalid role "${role}"`);
  }

  return {
    id: MessageId(messageId),
    role,
    content: str(item, "content") ?? "",
    createdAt: num(item, "createdAt"),
    // Spread conditionally: `exactOptionalPropertyTypes` distinguishes "absent"
    // from "present and undefined", and the domain type means the former.
    ...(item["toolCalls"] ? { toolCalls: item["toolCalls"] as NonNullable<Message["toolCalls"]> } : {}),
    ...(item["toolResults"] ? { toolResults: item["toolResults"] as NonNullable<Message["toolResults"]> } : {}),
    ...(item["citations"] ? { citations: item["citations"] as NonNullable<Message["citations"]> } : {}),
    ...(item["retrievedChunkIds"]
      ? { retrievedChunkIds: item["retrievedChunkIds"] as NonNullable<Message["retrievedChunkIds"]> }
      : {}),
    ...(item["shownProductIds"]
      ? { shownProductIds: item["shownProductIds"] as NonNullable<Message["shownProductIds"]> }
      : {}),
    ...(item["usage"] ? { usage: item["usage"] as NonNullable<Message["usage"]> } : {}),
    ...(typeof item["promptVersion"] === "string"
      ? { promptVersion: item["promptVersion"] }
      : {}),
  };
}

const str = (item: Record<string, unknown>, key: string): string | undefined =>
  typeof item[key] === "string" ? (item[key] as string) : undefined;

const num = (item: Record<string, unknown>, key: string): number =>
  typeof item[key] === "number" ? (item[key] as number) : 0;

function isConditionalCheckFailure(error: unknown): boolean {
  return (error as { name?: string })?.name === "ConditionalCheckFailedException";
}
