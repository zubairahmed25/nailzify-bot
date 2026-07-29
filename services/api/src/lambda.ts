/**
 * Lambda entry point.
 *
 * The ONLY file that touches the `awslambda` runtime global at module load. That
 * separation exists because `streamifyResponse` executes on import — a module
 * calling it cannot be imported anywhere the global is absent, which means no
 * unit tests and no bundler analysis. Keeping it in a thin entry file leaves
 * `handler.ts` (the actual request pipeline) importable everywhere.
 *
 * CDK points the function's handler at `lambda.handler`.
 */

import {
  createDynamoConversationRepo,
  createSecretsManagerProvider,
} from "@nailzify/adapters";
import {
  handleRequest,
  type FunctionUrlEvent,
  type ResponseStream,
} from "./handler.js";
import { buildContainer, type Container, type ContainerConfig } from "./composition-root.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace awslambda {
    function streamifyResponse(
      fn: (event: FunctionUrlEvent, stream: ResponseStream) => Promise<void>,
    ): unknown;
  }
}

/**
 * Built once per execution context and reused across warm invocations.
 *
 * Rebuilding SDK clients and re-fetching secrets per request adds ~30-50ms and
 * real API cost for values that change monthly at most.
 */
let container: Container | undefined;

async function getContainer(): Promise<Container> {
  if (container) return container;
  container = buildContainer(await loadConfig());
  return container;
}

function required(name: string): string {
  const value = process.env[name];
  // Fail at cold start, naming the variable. handleRequest turns this into a 503
  // without leaking configuration detail, and a container that never starts is
  // far better than one that fails partway through a customer's conversation.
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function loadConfig(): Promise<ContainerConfig> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const secrets = createSecretsManagerProvider({ region });

  // In parallel. Three sequential round trips would add ~90ms to every cold
  // start for values that have nothing to do with each other.
  const [proxySecret, storefrontToken, pineconeApiKey] = await Promise.all([
    secrets.get(required("PROXY_SECRET_ARN")),
    secrets.get(required("STOREFRONT_SECRET_ARN")),
    secrets.get(required("PINECONE_SECRET_ARN")),
  ]);

  return {
    region,
    proxySecret,
    storefrontToken,
    pineconeApiKey,
    pineconeIndex: required("PINECONE_INDEX"),
    shopDomain: required("SHOP_DOMAIN"),
    storefrontDomain: required("STOREFRONT_DOMAIN"),
    shopifyApiVersion: required("SHOPIFY_API_VERSION"),
    conversations: createDynamoConversationRepo({
      tableName: required("TABLE_NAME"),
      region,
    }),
    models: {
      chat: required("CHAT_MODEL_ID"),
      fast: required("FAST_MODEL_ID"),
      judge: required("FAST_MODEL_ID"),
    },
    onWarning: (message) =>
      console.warn(JSON.stringify({ level: "WARN", msg: "merchandising", detail: message })),
    onUsage: (usage) =>
      console.log(JSON.stringify({ level: "INFO", msg: "bedrock.usage", ...usage })),
  };
}

export const handler = awslambda.streamifyResponse(
  async (event: FunctionUrlEvent, responseStream: ResponseStream) => {
    await handleRequest(event, responseStream, getContainer);
  },
);
