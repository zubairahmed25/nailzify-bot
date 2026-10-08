import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CustomerId,
  SessionId,
  type CustomerOrderAuthChallenge,
  type CustomerOrderAuthRepository,
  type CustomerOrderSession,
} from "@nailzify/core";

export interface DynamoOrderAuthRepoConfig {
  readonly tableName: string;
  readonly region?: string;
  readonly client?: DynamoDBDocumentClient;
}

const challengePk = (stateHash: string) => `ORDERAUTH#${stateHash}`;
const sessionPk = (sessionId: string) => `SESSION#${sessionId}`;

export function createDynamoOrderAuthRepo(
  config: DynamoOrderAuthRepoConfig,
): CustomerOrderAuthRepository {
  const client = config.client ?? DynamoDBDocumentClient.from(
    new DynamoDBClient(config.region ? { region: config.region } : {}),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const table = config.tableName;

  return {
    async createChallenge(challenge) {
      await client.send(new PutCommand({
        TableName: table,
        Item: {
          PK: challengePk(challenge.stateHash),
          SK: "CHALLENGE",
          entityType: "CustomerOrderAuthChallenge",
          ...challenge,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
    },

    async consumeChallenge(stateHash) {
      const result = await client.send(new DeleteCommand({
        TableName: table,
        Key: { PK: challengePk(stateHash), SK: "CHALLENGE" },
        ReturnValues: "ALL_OLD",
      }));
      return result.Attributes ? toChallenge(result.Attributes) : null;
    },

    async saveSession(session) {
      await client.send(new PutCommand({
        TableName: table,
        Item: {
          PK: sessionPk(session.sessionId),
          SK: "ORDERAUTH",
          entityType: "CustomerOrderSession",
          GSI1PK: `CUSTOMER#${session.customerId}`,
          GSI1SK: `ORDERAUTH#${String(session.createdAt).padStart(15, "0")}`,
          ...session,
        },
      }));
    },

    async loadSession(sessionId) {
      const result = await client.send(new GetCommand({
        TableName: table,
        Key: { PK: sessionPk(sessionId), SK: "ORDERAUTH" },
        ConsistentRead: true,
      }));
      return result.Item ? toSession(result.Item) : null;
    },

    async deleteSession(sessionId) {
      await client.send(new DeleteCommand({
        TableName: table,
        Key: { PK: sessionPk(sessionId), SK: "ORDERAUTH" },
      }));
    },

    async appendAudit(event, ttlEpochSeconds) {
      await client.send(new PutCommand({
        TableName: table,
        Item: {
          PK: sessionPk(event.sessionId),
          SK: `ORDERAUDIT#${String(event.createdAt).padStart(15, "0")}#${event.id}`,
          entityType: "CustomerOrderAudit",
          eventId: event.id,
          shop: event.shop,
          sessionId: event.sessionId,
          customerReference: event.customerReference,
          operation: event.operation,
          result: event.result,
          latencyMs: event.latencyMs,
          createdAt: event.createdAt,
          expiresAt: ttlEpochSeconds,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
    },

    async consumeRateLimit(keyHash, windowEpochSeconds, limit) {
      try {
        await client.send(new UpdateCommand({
          TableName: table,
          Key: { PK: `RATELIMIT#${keyHash}`, SK: `WINDOW#${windowEpochSeconds}` },
          UpdateExpression: "SET #expiresAt = :expiresAt ADD #count :one",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: { "#count": "count", "#expiresAt": "expiresAt" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":limit": limit,
            ":expiresAt": windowEpochSeconds + 120,
          },
        }));
        return true;
      } catch (error) {
        if (isConditionalCheckFailure(error)) return false;
        throw error;
      }
    },
  };
}

function toChallenge(item: Record<string, unknown>): CustomerOrderAuthChallenge {
  return {
    stateHash: requiredString(item, "stateHash"),
    shop: requiredString(item, "shop"),
    sessionId: SessionId(requiredString(item, "sessionId")),
    nonceHash: requiredString(item, "nonceHash"),
    encryptedCodeVerifier: requiredString(item, "encryptedCodeVerifier"),
    returnUrl: requiredString(item, "returnUrl"),
    createdAt: requiredNumber(item, "createdAt"),
    expiresAt: requiredNumber(item, "expiresAt"),
  };
}

function toSession(item: Record<string, unknown>): CustomerOrderSession {
  return {
    shop: requiredString(item, "shop"),
    sessionId: SessionId(requiredString(item, "sessionId")),
    customerId: CustomerId(requiredString(item, "customerId")),
    encryptedAccessToken: requiredString(item, "encryptedAccessToken"),
    createdAt: requiredNumber(item, "createdAt"),
    expiresAt: requiredNumber(item, "expiresAt"),
  };
}

function requiredString(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  if (typeof value !== "string" || !value) throw new Error(`Order auth record is missing ${key}`);
  return value;
}

function requiredNumber(item: Record<string, unknown>, key: string): number {
  const value = item[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Order auth record is missing ${key}`);
  }
  return value;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as { name?: string }).name === "ConditionalCheckFailedException";
}
