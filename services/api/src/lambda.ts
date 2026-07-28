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

async function loadConfig(): Promise<ContainerConfig> {
  // Left unimplemented until the CDK stack exists — it needs the DynamoDB table
  // name and the secret ARNs that stack creates, plus a DynamoDB implementation
  // of ConversationRepository which is not written yet.
  //
  // Throwing loudly at cold start beats a half-configured container that fails
  // partway through a customer's conversation. handleRequest turns this into a
  // 503 without leaking any configuration detail.
  throw new Error(
    "loadConfig() is not implemented — wire Secrets Manager + the DynamoDB " +
      "ConversationRepository once the CDK stack lands. See docs/09-deployment.md §9.7.",
  );
}

export const handler = awslambda.streamifyResponse(
  async (event: FunctionUrlEvent, responseStream: ResponseStream) => {
    await handleRequest(event, responseStream, getContainer);
  },
);
