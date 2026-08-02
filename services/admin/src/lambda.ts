/**
 * Lambda entry point for the admin service.
 *
 * Thin, same discipline as services/api and services/ingestion: resolve
 * configuration, build the dependencies once, delegate to handler.ts. No
 * `awslambda` runtime global here — this Function URL is BUFFERED, not
 * RESPONSE_STREAM, so the native Lambda invocation shape (`async (event) =>
 * response`) is enough, and `handler.ts` stays importable and testable
 * anywhere.
 *
 * CDK points the function's handler at `lambda.handler`.
 */

import { createSecretsManagerProvider } from "@nailzify/adapters";
import { buildAdminDeps, type AdminConfig, type AdminDeps } from "./composition-root.js";
import { handleAdminRequest, type AdminEvent, type AdminResponse } from "./handler.js";

/**
 * Built once per execution context, reused across warm invocations — the same
 * reasoning as every other Lambda in this project: secrets and SDK clients
 * change on a monthly cadence at most, not per request.
 */
let deps: AdminDeps | undefined;

async function getDeps(): Promise<AdminDeps> {
  if (deps) return deps;
  deps = buildAdminDeps(await loadConfig());
  return deps;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function loadConfig(): Promise<AdminConfig> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const secrets = createSecretsManagerProvider({ region });

  return {
    region,
    tableName: required("TABLE_NAME"),
    documentBucket: required("DOCUMENT_BUCKET"),
    // Same secret the chat Lambda's App Proxy check uses — see
    // security/verify-session-token.ts for why this is the correct secret and
    // not a new one.
    sessionSecret: await secrets.get(required("PROXY_SECRET_ARN")),
    apiKey: required("SHOPIFY_API_KEY"),
    shopDomain: required("SHOP_DOMAIN"),
  };
}

export async function handler(event: AdminEvent): Promise<AdminResponse> {
  try {
    return await handleAdminRequest(event, await getDeps());
  } catch (cause) {
    // Never leak configuration or internal detail to the admin page.
    console.error(
      JSON.stringify({
        level: "ERROR",
        msg: "admin.request.failed",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return {
      statusCode: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Service is not configured" }),
    };
  }
}
