import { describe, expect, it, vi } from "vitest";
import { CustomerId, MessageId, SessionId, createSession, type Message } from "@nailzify/core";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ConcurrentSessionUpdate,
  createDynamoConversationRepo,
} from "./conversation-repo.js";

const NOW = 1_700_000_000_000;
const TABLE = "nailzify-test";

/** Captures the command DynamoDB would have received. */
interface Sent {
  readonly name: string;
  readonly input: Record<string, any>;
}

function fakeClient(responses: Record<string, unknown> = {}, failures: Record<string, Error> = {}) {
  const sent: Sent[] = [];

  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    const name = command.constructor.name;
    sent.push({ name, input: command.input as Record<string, any> });
    const failure = failures[name];
    if (failure) throw failure;
    return responses[name] ?? {};
  });

  return { client: { send } as unknown as DynamoDBDocumentClient, sent };
}

const conditionalFailure = () => Object.assign(new Error("condition failed"), {
  name: "ConditionalCheckFailedException",
});

const repoWith = (responses = {}, failures = {}) => {
  const fake = fakeClient(responses, failures);
  return {
    repo: createDynamoConversationRepo({ tableName: TABLE, client: fake.client }),
    sent: fake.sent,
    find: (name: string) => fake.sent.find((s) => s.name === name),
    all: (name: string) => fake.sent.filter((s) => s.name === name),
  };
};

const message = (over: Partial<Message> = {}): Message => ({
  id: MessageId("m1"),
  role: "user",
  content: "do you ship to the UK?",
  createdAt: NOW,
  ...over,
});

// ---------------------------------------------------------------------------

describe("key design", () => {
  it("co-locates messages under the session partition", async () => {
    // One query loads a whole conversation — no join, no N round trips. That is
    // the entire reason the keys look like this.
    const { repo, find } = repoWith();
    await repo.appendMessages(SessionId("s1"), [message()], 123);

    const item = find("PutCommand")!.input["Item"];
    expect(item["PK"]).toBe("SESSION#s1");
    expect(item["SK"]).toMatch(/^MSG#/);
  });

  it("zero-pads the timestamp so sort keys order chronologically", async () => {
    // DynamoDB sorts sort keys LEXICOGRAPHICALLY. Unpadded, "9999" sorts after
    // "10000" and the conversation comes back scrambled.
    const { repo, all } = repoWith();

    await repo.appendMessages(SessionId("s1"), [
      message({ id: MessageId("m1"), createdAt: 9_999 }),
      message({ id: MessageId("m2"), createdAt: 10_000 }),
    ], 1);

    const keys = all("PutCommand").map((s) => s.input["Item"]["SK"] as string);
    expect([...keys].sort()).toEqual(keys.slice().sort());
    // The earlier timestamp must sort first as a string.
    const [a, b] = keys.sort();
    expect(a).toContain("000000000009999");
    expect(b).toContain("000000000010000");
  });

  it("derives the sort key from messageId so writes are idempotent", async () => {
    const { repo, all } = repoWith();
    const msg = message();

    await repo.appendMessages(SessionId("s1"), [msg], 1);
    await repo.appendMessages(SessionId("s1"), [msg], 1);

    const keys = all("PutCommand").map((s) => s.input["Item"]["SK"]);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("idempotency", () => {
  it("treats a duplicate message write as success", async () => {
    // A double-clicked send must not error or duplicate the turn.
    const { repo } = repoWith({}, { PutCommand: conditionalFailure() });

    await expect(repo.appendMessages(SessionId("s1"), [message()], 1)).resolves.toBeUndefined();
  });

  it("still surfaces a real write failure", async () => {
    const { repo } = repoWith({}, { PutCommand: new Error("ProvisionedThroughputExceeded") });

    await expect(repo.appendMessages(SessionId("s1"), [message()], 1)).rejects.toThrow(
      /ProvisionedThroughput/,
    );
  });

  it("writes nothing for an empty batch", async () => {
    const { repo, sent } = repoWith();
    await repo.appendMessages(SessionId("s1"), [], 1);
    expect(sent).toHaveLength(0);
  });
});

describe("optimistic concurrency", () => {
  it("conditions the write on the expected version", async () => {
    // Two browser tabs posting at once would otherwise interleave turns into
    // nonsense.
    const { repo, find } = repoWith();
    const session = { ...createSession(SessionId("s1"), null, NOW), version: 3 };

    await repo.saveSession(session, 2);

    const input = find("PutCommand")!.input;
    expect(input["ConditionExpression"]).toContain("version = :expected");
    expect(input["ExpressionAttributeValues"][":expected"]).toBe(2);
  });

  it("translates a lost race into a domain error", async () => {
    const { repo } = repoWith({}, { PutCommand: conditionalFailure() });
    const session = createSession(SessionId("s1"), null, NOW);

    await expect(repo.saveSession(session, 5)).rejects.toBeInstanceOf(ConcurrentSessionUpdate);
  });

  it("guards session creation against a concurrent create", async () => {
    const { repo, find } = repoWith();

    await repo.createSession(createSession(SessionId("s1"), null, NOW));

    expect(find("PutCommand")!.input["ConditionExpression"]).toBe("attribute_not_exists(PK)");
  });
});

describe("TTL", () => {
  it("writes epoch SECONDS, not milliseconds", async () => {
    // ⚠️ Milliseconds parse as a date ~50,000 years out, so DynamoDB silently
    // never expires anything and customer messages accumulate forever.
    const { repo, find } = repoWith();
    const session = createSession(SessionId("s1"), null, NOW);

    await repo.createSession(session);

    const expiresAt = find("PutCommand")!.input["Item"]["expiresAt"] as number;
    expect(expiresAt).toBe(Math.floor(NOW / 1000) + 30 * 86_400);
    // Sanity: seconds are ~1000x smaller than the millisecond clock.
    expect(expiresAt).toBeLessThan(NOW);
  });

  it("honours a configured retention window", async () => {
    const fake = fakeClient();
    const repo = createDynamoConversationRepo({
      tableName: TABLE,
      client: fake.client,
      retentionDays: 7,
    });

    await repo.createSession(createSession(SessionId("s1"), null, NOW));

    const expiresAt = fake.sent[0]!.input["Item"]["expiresAt"] as number;
    expect(expiresAt).toBe(Math.floor(NOW / 1000) + 7 * 86_400);
  });
});

describe("reading a conversation", () => {
  it("queries newest-first then returns chronological order", async () => {
    // Querying ascending with a Limit returns the OLDEST messages — the exact
    // opposite of what a conversation window needs.
    const { repo, find } = repoWith({
      QueryCommand: {
        Items: [
          { messageId: "m3", role: "user", content: "third", createdAt: 3 },
          { messageId: "m2", role: "assistant", content: "second", createdAt: 2 },
          { messageId: "m1", role: "user", content: "first", createdAt: 1 },
        ],
      },
    });

    const messages = await repo.loadRecentMessages(SessionId("s1"), 10);

    expect(find("QueryCommand")!.input["ScanIndexForward"]).toBe(false);
    expect(messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("reads the session consistently", async () => {
    // Turn N must see turn N-1, or the bot appears to forget the message the
    // customer just sent.
    const { repo, find } = repoWith({
      GetCommand: {
        Item: {
          sessionId: "s1",
          createdAt: NOW,
          lastActiveAt: NOW,
          turnCount: 2,
          tokensUsed: 400,
          version: 2,
          escalated: false,
        },
      },
    });

    const session = await repo.loadSession(SessionId("s1"));

    expect(find("GetCommand")!.input["ConsistentRead"]).toBe(true);
    expect(session?.turnCount).toBe(2);
    expect(session?.version).toBe(2);
  });

  it("returns null for an unknown session", async () => {
    const { repo } = repoWith({ GetCommand: {} });
    expect(await repo.loadSession(SessionId("nope"))).toBeNull();
  });
});

describe("round-tripping provenance", () => {
  it("preserves the attributes that make a wrong answer diagnosable", async () => {
    const { repo, find } = repoWith();
    const assistant = message({
      id: MessageId("a1"),
      role: "assistant",
      content: "We ship to the UK.",
      citations: [
        {
          sourceId: 1,
          documentId: "shipping-policy" as never,
          chunkId: "shipping-policy#s1#c0" as never,
          title: "Shipping Policy",
          page: 4,
        },
      ],
      retrievedChunkIds: ["shipping-policy#s1#c0" as never],
      usage: { inputTokens: 3211, outputTokens: 187, cacheReadInputTokens: 2890 },
      promptVersion: "2026-07-27.1",
    });

    await repo.appendMessages(SessionId("s1"), [assistant], 1);

    const item = find("PutCommand")!.input["Item"];
    expect(item["retrievedChunkIds"]).toEqual(["shipping-policy#s1#c0"]);
    expect(item["promptVersion"]).toBe("2026-07-27.1");
    expect(item["usage"]["cacheReadInputTokens"]).toBe(2890);
  });

  it("reads an assistant message back with its provenance", async () => {
    const { repo } = repoWith({
      QueryCommand: {
        Items: [
          {
            messageId: "a1",
            role: "assistant",
            content: "answer",
            createdAt: NOW,
            promptVersion: "2026-07-27.1",
            retrievedChunkIds: ["c1"],
          },
        ],
      },
    });

    const [msg] = await repo.loadRecentMessages(SessionId("s1"), 10);

    expect(msg!.promptVersion).toBe("2026-07-27.1");
    expect(msg!.retrievedChunkIds).toEqual(["c1"]);
  });

  it("omits absent optional fields rather than storing null", async () => {
    const { repo } = repoWith({
      QueryCommand: {
        Items: [{ messageId: "m1", role: "user", content: "hi", createdAt: NOW }],
      },
    });

    const [msg] = await repo.loadRecentMessages(SessionId("s1"), 10);

    expect("citations" in msg!).toBe(false);
    expect("usage" in msg!).toBe(false);
  });
});

describe("customer lookup", () => {
  it("indexes signed-in sessions for deletion requests", async () => {
    // One query on GSI1 returns every session for a customer, which is how a
    // GDPR erasure request is serviced. Design for it on day one.
    const { repo, find } = repoWith();
    const session = createSession(SessionId("s1"), CustomerId("gid://shopify/Customer/7712"), NOW);

    await repo.createSession(session);

    const item = find("PutCommand")!.input["Item"];
    expect(item["GSI1PK"]).toBe("CUSTOMER#gid://shopify/Customer/7712");
  });

  it("omits the index entry for anonymous sessions", async () => {
    // Most storefront visitors are not signed in. Writing a GSI entry keyed on
    // nothing would just cost money.
    const { repo, find } = repoWith();

    await repo.createSession(createSession(SessionId("s1"), null, NOW));

    expect(find("PutCommand")!.input["Item"]["GSI1PK"]).toBeUndefined();
  });
});

describe("corrupt data", () => {
  it("throws rather than returning a half-built session", async () => {
    const { repo } = repoWith({ GetCommand: { Item: { turnCount: 1 } } });

    await expect(repo.loadSession(SessionId("s1"))).rejects.toThrow(/missing sessionId/);
  });

  it("rejects an invalid message role", async () => {
    const { repo } = repoWith({
      QueryCommand: { Items: [{ messageId: "m1", role: "system", content: "x", createdAt: 1 }] },
    });

    await expect(repo.loadRecentMessages(SessionId("s1"), 10)).rejects.toThrow(/invalid role/);
  });
});
