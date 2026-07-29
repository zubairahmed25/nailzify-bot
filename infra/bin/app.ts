/**
 * CDK app entry point.
 *
 * Stacks are instantiated per environment with prefixed resource names. Separate
 * AWS accounts per environment is the correct end state — it gives hard
 * blast-radius isolation and clean cost attribution — but AWS Organizations
 * setup is its own project and should not block shipping. Migrate when the
 * system matters enough to justify it (docs/09-deployment.md §9.3).
 */

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { DataStack } from "../lib/data-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { IngestionStack } from "../lib/ingestion-stack.js";

const app = new cdk.App();

const envName = app.node.tryGetContext("env") ?? process.env["NAILZIFY_ENV"] ?? "dev";

const env: cdk.Environment = {
  account: process.env["CDK_DEFAULT_ACCOUNT"] ?? "",
  // us-east-1 is not arbitrary: widest Bedrock model availability, CloudFront
  // and WAF control planes live there, and Pinecone Serverless can be
  // co-located to shave ~30ms off every vector query.
  region: process.env["CDK_DEFAULT_REGION"] ?? "us-east-1",
};

// Store configuration. Non-secret, so it lives in code rather than Secrets
// Manager — these are identifiers, not credentials.
const config = {
  shopDomain: app.node.tryGetContext("shopDomain") ?? "nailzify.myshopify.com",
  storefrontDomain: app.node.tryGetContext("storefrontDomain") ?? "nailzify.com",
  pineconeIndex: `nailzify-${envName}`,

  // ⚠️ Shopify supports each API version for ~12 months, then retires it. A
  // stale value fails like a bad credential rather than saying "version gone",
  // so this needs a periodic review — verified working via
  // scripts/diagnose-shopify.ts.
  shopifyApiVersion: app.node.tryGetContext("shopifyApiVersion") ?? "2025-10",

  // ⚠️ INFERENCE PROFILE IDs, not bare model IDs. A bare
  // `anthropic.claude-sonnet-4-6` returns ValidationException — current Claude
  // models on Bedrock require a cross-region profile, and the error does not
  // say so (docs/02-aws-services.md §2.1).
  // ⚠️ MODEL ACCESS IS PER-ACCOUNT AND PER-MODEL, AND IT IS NOT AUTOMATIC.
  //
  // These were pinned to Claude Sonnet 5, which this account cannot invoke:
  //
  //   403 anthropic.claude-sonnet-5 is not available for this account
  //
  // Probed with bedrock-runtime converse against each candidate. Sonnet 4.6 and
  // Haiku 4.5 succeed; Sonnet 5 is denied. Nothing degrades gracefully here on
  // purpose — silently downgrading the model would change answer quality with
  // no one aware, so the request fails and says why.
  //
  // Request access in the Bedrock console (Model access) and change this back.
  // Re-probe rather than assume: access is granted per model, not per family.
  chatModelId: "us.anthropic.claude-sonnet-4-6",
  fastModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  embedModelId: "cohere.embed-v4:0",
  rerankModelId: "cohere.rerank-v3-5:0",
};

const data = new DataStack(app, `Nailzify-${envName}-Data`, { env, envName });

const api = new ApiStack(app, `Nailzify-${envName}-Api`, {
  env,
  envName,
  table: data.table,
  proxySecret: data.shopifyProxySecret,
  storefrontSecret: data.shopifyStorefrontSecret,
  pineconeSecret: data.pineconeSecret,
  ...config,
});

const ingestion = new IngestionStack(app, `Nailzify-${envName}-Ingestion`, {
  env,
  envName,
  table: data.table,
  documentsBucket: data.documentsBucket,
  storefrontSecret: data.shopifyStorefrontSecret,
  pineconeSecret: data.pineconeSecret,
  shopDomain: config.shopDomain,
  storefrontDomain: config.storefrontDomain,
  pineconeIndex: config.pineconeIndex,
  shopifyApiVersion: config.shopifyApiVersion,
  embedModelId: config.embedModelId,
});

// No explicit dependency call. The API stack references the Data stack's table
// and secrets, and CDK derives the ordering from those references. Declaring it
// by hand was what turned an ordinary reference into a reported CYCLE once
// Origin Access Control added a policy pointing the other way.

cdk.Tags.of(app).add("Project", "nailzify-concierge");
cdk.Tags.of(app).add("Environment", envName);

// ---------------------------------------------------------------------------
// cdk-nag: static security analysis over the synthesized template.
//
// Catches unencrypted buckets, wildcard IAM, missing log retention, public
// access. Suppressions require a written justification — which turns each one
// into documentation of a deliberate decision rather than an oversight.
// ---------------------------------------------------------------------------

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

NagSuppressions.addStackSuppressions(ingestion, [
  {
    id: "AwsSolutions-L1",
    reason: "Node 22 is the current LTS runtime for Lambda at time of writing.",
  },
  {
    id: "AwsSolutions-IAM4",
    reason:
      "AWSLambdaBasicExecutionRole is the AWS-managed policy for CloudWatch Logs. " +
      "Replacing it with an inline policy would reimplement it verbatim.",
  },
  {
    id: "AwsSolutions-IAM5",
    reason:
      "The Bedrock embedding ARN wildcards REGION only; the model identifier is " +
      "explicit and the action is InvokeModel alone. S3 read is scoped to the " +
      "document bucket with a wildcard on object key, which is what reading any " +
      "uploaded document requires.",
  },
  {
    id: "AwsSolutions-S1",
    reason:
      "No server access logging on the document bucket. Object-level activity is " +
      "already captured by the Lambda's own structured logs, and a second bucket " +
      "to log reads of two policy documents is cost and surface for no signal.",
  },
]);

NagSuppressions.addStackSuppressions(api, [
  {
    id: "AwsSolutions-IAM4",
    reason:
      "AWSLambdaBasicExecutionRole is the AWS-managed policy for CloudWatch Logs. " +
      "Replacing it with an inline policy would reimplement it verbatim with no " +
      "security gain.",
  },
  {
    id: "AwsSolutions-IAM5",
    reason:
      "Bedrock foundation-model ARNs are wildcarded on REGION only, because " +
      "cross-region inference profiles route across US regions by design. The " +
      "model identifiers themselves are explicit — this is not bedrock:* on *.",
  },
  {
    id: "AwsSolutions-CFR4",
    reason:
      "CloudFront uses the default certificate, which enforces TLSv1 minimum. " +
      "Tightening this requires a custom domain and ACM certificate — planned " +
      "alongside the production Shopify App Proxy configuration.",
  },
  {
    id: "AwsSolutions-CFR1",
    reason:
      "No geo restriction. The store ships internationally (docs/03-ingestion.md " +
      "shipping policy), so blocking regions would block real customers.",
  },
  {
    id: "AwsSolutions-CFR3",
    reason:
      "CloudFront access logging is deferred. Request-level observability comes " +
      "from structured Lambda logs and X-Ray, which carry the correlation IDs " +
      "access logs lack (docs/10-operations.md §10.2).",
  },
  {
    id: "AwsSolutions-L1",
    reason: "Node 22 is the current LTS runtime for Lambda at time of writing.",
  },
  {
    id: "AwsSolutions-S1",
    reason:
      "The widget bucket has no server access logging. It holds only public, " +
      "content-hashed build artifacts and is never reachable directly — every " +
      "read arrives through CloudFront, so CloudFront access logs (not S3 ones) " +
      "are where request-level data would come from.",
  },
]);

NagSuppressions.addStackSuppressions(data, [
  {
    id: "AwsSolutions-S1",
    reason:
      "S3 server access logging is deferred for dev. Object-level events that " +
      "matter (document upload) are delivered via EventBridge and recorded in " +
      "the ingestion job table.",
  },
  {
    id: "AwsSolutions-SMG4",
    reason:
      "Automatic rotation is not enabled: these are third-party credentials " +
      "(Shopify, Pinecone) whose rotation requires an out-of-band step in each " +
      "vendor's console. Rotation is a documented manual runbook.",
  },
  {
    id: "AwsSolutions-IAM4",
    reason: "AWS-managed policy on the auto-delete-objects helper for non-prod buckets only.",
  },
  {
    id: "AwsSolutions-IAM5",
    reason: "The auto-delete-objects helper needs object-level wildcards within its own bucket.",
  },
  {
    id: "AwsSolutions-L1",
    reason: "Runtime of the CDK-generated auto-delete-objects helper is not under our control.",
  },
]);
