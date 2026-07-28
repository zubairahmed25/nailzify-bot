import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@nailzify/core";
import { handleRequest, type FunctionUrlEvent, type ResponseStream } from "./handler.js";
import type { Container } from "./composition-root.js";
import { computeSignature } from "./security/verify-app-proxy.js";

const SECRET = "shpss_test_secret";

// ---------------------------------------------------------------------------
// The Lambda runtime injects `awslambda` as a global. Stand it up for tests.
// ---------------------------------------------------------------------------

interface Captured {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeStream() {
  const captured: Captured = { statusCode: 0, headers: {}, body: "", ended: false };

  const stream: ResponseStream = {
    write: (chunk) => {
      captured.body += chunk;
    },
    end: () => {
      captured.ended = true;
    },
  };

  (globalThis as Record<string, unknown>)["awslambda"] = {
    streamifyResponse: (h: unknown) => h,
    HttpResponseStream: {
      from: (target: ResponseStream, metadata: { statusCode: number; headers: Record<string, string> }) => {
        captured.statusCode = metadata.statusCode;
        captured.headers = metadata.headers;
        return target;
      },
    },
  };

  return { stream, captured };
}

function fakeContainer(events: ChatEvent[] = [{ type: "token", text: "hi" }]): Container {
  return {
    proxySecret: SECRET,
    handleMessage: vi.fn(async function* () {
      for (const event of events) yield event;
    }) as unknown as Container["handleMessage"],
  };
}

function request(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  const params: Record<string, string> = {
    shop: "nailzify.myshopify.com",
    path_prefix: "/apps/nailzify-chat",
  };
  const query = new URLSearchParams({
    ...params,
    signature: computeSignature(params, SECRET),
  });

  return {
    requestContext: { http: { method: "POST" } },
    rawQueryString: query.toString(),
    body: JSON.stringify({
      sessionId: "01JQZ8K2M4ABCDEF",
      messageId: "01JQZ9AAAABBBBCC",
      message: "do you ship to the UK?",
    }),
    ...overrides,
  };
}

const parseFrames = (body: string) =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);

// ---------------------------------------------------------------------------

describe("rejection ordering — cheapest first", () => {
  it("rejects a non-POST before anything else", async () => {
    const { stream, captured } = fakeStream();
    const container = fakeContainer();

    await handleRequest(
      request({ requestContext: { http: { method: "GET" } } }),
      stream,
      async () => container,
    );

    expect(captured.statusCode).toBe(405);
    expect(container.handleMessage).not.toHaveBeenCalled();
  });

  it("rejects an unsigned request without invoking the model", async () => {
    // The whole point: an unauthenticated endpoint in front of a metered LLM is
    // a financial vulnerability. Nothing may cost money before this check.
    const { stream, captured } = fakeStream();
    const container = fakeContainer();

    await handleRequest(
      request({ rawQueryString: "shop=nailzify.myshopify.com" }),
      stream,
      async () => container,
    );

    expect(captured.statusCode).toBe(401);
    expect(container.handleMessage).not.toHaveBeenCalled();
  });

  it("does not explain why authentication failed", async () => {
    // Telling an attacker the reason helps them iterate. The detail goes to logs.
    const { stream, captured } = fakeStream();

    await handleRequest(
      request({ rawQueryString: "shop=x&signature=deadbeef" }),
      stream,
      async () => fakeContainer(),
    );

    expect(captured.body).toBe(JSON.stringify({ error: "Unauthorized" }));
    expect(captured.body).not.toContain("signature");
  });

  it("rejects a malformed body after the signature passes", async () => {
    const { stream, captured } = fakeStream();
    const container = fakeContainer();

    await handleRequest(request({ body: "{not json" }), stream, async () => container);

    expect(captured.statusCode).toBe(400);
    expect(container.handleMessage).not.toHaveBeenCalled();
  });

  it("rejects an over-long message as a cost control", async () => {
    const { stream, captured } = fakeStream();

    await handleRequest(
      request({
        body: JSON.stringify({
          sessionId: "01JQZ8K2M4ABCDEF",
          messageId: "01JQZ9AAAABBBBCC",
          message: "x".repeat(5000),
        }),
      }),
      stream,
      async () => fakeContainer(),
    );

    expect(captured.statusCode).toBe(400);
  });

  it("returns 503 without leaking configuration detail", async () => {
    const { stream, captured } = fakeStream();

    await handleRequest(request(), stream, async () => {
      throw new Error("SECRET_ARN is not set for arn:aws:secretsmanager:...");
    });

    expect(captured.statusCode).toBe(503);
    expect(captured.body).not.toContain("arn:aws");
  });
});

describe("streaming", () => {
  it("emits SSE frames with the right headers", async () => {
    const { stream, captured } = fakeStream();

    await handleRequest(request(), stream, async () =>
      fakeContainer([
        { type: "token", text: "We ship " },
        { type: "token", text: "to the UK." },
      ]),
    );

    expect(captured.statusCode).toBe(200);
    expect(captured.headers["content-type"]).toBe("text/event-stream");
    // Caching a chat response would serve one customer's answer to another.
    expect(captured.headers["cache-control"]).toContain("no-cache");

    const frames = parseFrames(captured.body);
    expect(frames.map((f) => f["text"]).join("")).toBe("We ship to the UK.");
    expect(captured.ended).toBe(true);
  });

  it("terminates frames with a blank line", async () => {
    // The blank line IS the delimiter. Omit it and the client buffers forever.
    const { stream, captured } = fakeStream();

    await handleRequest(request(), stream, async () =>
      fakeContainer([{ type: "token", text: "hi" }]),
    );

    expect(captured.body).toMatch(/\n\n$/);
  });

  it("converts a mid-stream failure into an in-band error frame", async () => {
    // The 200 is already committed by the time generation starts, so there is
    // no way to turn this into a 500. Leaving the connection open would read as
    // a frozen chat.
    const { stream, captured } = fakeStream();
    const container: Container = {
      proxySecret: SECRET,
      handleMessage: (async function* () {
        yield { type: "token", text: "partial" } as ChatEvent;
        throw new Error("Bedrock exploded");
      }) as unknown as Container["handleMessage"],
    };

    await handleRequest(request(), stream, async () => container);

    const frames = parseFrames(captured.body);
    expect(frames.at(-1)?.["type"]).toBe("error");
    expect(captured.ended).toBe(true);
    // Never leak internals to a customer.
    expect(captured.body).not.toContain("Bedrock exploded");
  });
});

describe("identity", () => {
  it("passes the signed customer id through to the use case", async () => {
    const { stream } = fakeStream();
    const container = fakeContainer();

    const params: Record<string, string> = {
      shop: "nailzify.myshopify.com",
      logged_in_customer_id: "gid://shopify/Customer/7712",
    };
    const query = new URLSearchParams({ ...params, signature: computeSignature(params, SECRET) });

    await handleRequest(
      request({ rawQueryString: query.toString() }),
      stream,
      async () => container,
    );

    expect(container.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "gid://shopify/Customer/7712" }),
    );
  });

  it("passes null for an anonymous shopper", async () => {
    const { stream } = fakeStream();
    const container = fakeContainer();

    await handleRequest(request(), stream, async () => container);

    expect(container.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: null }),
    );
  });
});

describe("query parsing", () => {
  it("preserves repeated parameters so the signature still verifies", async () => {
    // queryStringParameters collapses duplicates, which would corrupt the
    // signature input. Parsing rawQueryString ourselves keeps them intact.
    const { stream, captured } = fakeStream();
    const params: Record<string, string | string[]> = { shop: "x", ids: ["1", "2"] };
    const query = new URLSearchParams();
    query.set("shop", "x");
    query.append("ids", "1");
    query.append("ids", "2");
    query.set("signature", computeSignature(params, SECRET));

    await handleRequest(
      request({ rawQueryString: query.toString() }),
      stream,
      async () => fakeContainer(),
    );

    expect(captured.statusCode).toBe(200);
  });

  it("handles a base64-encoded body", async () => {
    const { stream, captured } = fakeStream();
    const body = JSON.stringify({
      sessionId: "01JQZ8K2M4ABCDEF",
      messageId: "01JQZ9AAAABBBBCC",
      message: "hello",
    });

    await handleRequest(
      request({ body: Buffer.from(body).toString("base64"), isBase64Encoded: true }),
      stream,
      async () => fakeContainer(),
    );

    expect(captured.statusCode).toBe(200);
  });
});
