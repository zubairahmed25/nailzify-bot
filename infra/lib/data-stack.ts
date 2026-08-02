/**
 * Data stack — everything stateful.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE STACK
 * ============================================================================
 *
 * Stacks are split by LIFECYCLE and BLAST RADIUS, not by service type. You will
 * deploy the API stack twenty times a week and this one twice a year.
 *
 * That separation matters because CloudFormation will happily REPLACE a DynamoDB
 * table if a property change requires it — and replacement means the old table
 * is deleted. Keeping stateful resources out of the stack you deploy constantly,
 * plus `RemovalPolicy.RETAIN`, means a routine API deploy cannot propose a change
 * that destroys customer conversations.
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export interface DataStackProps extends cdk.StackProps {
  readonly envName: string;
  /**
   * The Api stack's CloudFront domain (e.g. `d183repo6i6gjz.cloudfront.net`)
   * — needed only for the documents bucket's CORS rule, see below. Passed as
   * a plain string rather than a real CDK cross-stack reference: the
   * distribution lives in ApiStack, which already depends on THIS stack for
   * the table and bucket, so a reference the other way would be the exact
   * cycle infra/bin/app.ts's OAC comment warns about. The domain is stable
   * once the distribution exists (CloudFront doesn't reassign it on
   * redeploy), so a bootstrapped config value — same pattern as
   * `shopifyApiKey` — is the right tradeoff, not a real dependency.
   */
  readonly distributionDomain: string;
}

export class DataStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly documentsBucket: s3.Bucket;
  readonly shopifyProxySecret: secretsmanager.Secret;
  readonly shopifyStorefrontSecret: secretsmanager.Secret;
  readonly pineconeSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { envName } = props;

    // ---- Conversations ----------------------------------------------------
    this.table = new dynamodb.Table(this, "AppTable", {
      tableName: `nailzify-${envName}-app`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },

      // On-demand: costs more per request, nothing when idle, and needs no
      // capacity planning. A storefront chatbot is idle most of the day.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // Session expiry as an attribute rather than a cron job. Also the
      // data-minimisation control for customer messages.
      timeToLiveAttribute: "expiresAt",

      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,

      // ⚠️ NEVER auto-delete a table holding customer conversations. In dev we
      // still retain — an accidental `cdk destroy` should not be silent data
      // loss, and an orphaned dev table costs pennies.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Backs "every session for this customer" (sessionId/createdAt) AND,
    // since packages/adapters/src/dynamodb/ingestion-state.ts reused this same
    // GSI for admin-uploaded PDFs, "every upload, newest first" too.
    //
    // ⚠️ EVERY FIELD A GSI READER NEEDS MUST BE LISTED HERE. This is not
    // optional metadata — DynamoDB physically does not copy unprojected
    // attributes into the index, and a Query against it returns exactly what
    // was projected and nothing else, silently. `listUploadedDocuments()`
    // querying GSI1 for status/title/s3Key/etc. with only sessionId/createdAt
    // projected got back items with just the key attributes — every other
    // field genuinely absent, not merely empty. `toUploadedDocument`'s
    // defensive fallbacks then made every upload look permanently stuck
    // "processing" against a live table, invisible in tests because the
    // mocked DynamoDB client there doesn't enforce projection filtering the
    // way the real service does. Confirmed by querying this GSI directly.
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      // Only the attributes any GSI1 reader needs. A GSI is a full copy of
      // whatever you project, with its own write cost — ALL is rarely the
      // right answer.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "sessionId",
        "createdAt",
        "status",
        "title",
        "docType",
        "errorMessage",
        "s3Key",
        "uploadedAt",
        "updatedAt",
      ],
    });

    // ---- Source documents -------------------------------------------------
    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName: `nailzify-${envName}-documents-${this.account}`,
      // A bad re-upload is recoverable, and versioning is what makes the
      // vector index reproducible from source.
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Uploading a document IS the ingestion trigger — no polling, no queue to
      // babysit, no "reindex" button.
      eventBridgeEnabled: true,
      // The admin page's browser PUTs a PDF directly to this bucket via a
      // presigned URL (services/admin/src/composition-root.ts) — the upload
      // never passes through a Lambda, so the BROWSER's own origin is what
      // needs CORS permission here.
      //
      // ⚠️ WRONG THE FIRST TIME: this listed https://admin.shopify.com and the
      // shop's own myshopify.com domain, on the assumption that "embedded in
      // Shopify admin" meant the request's Origin would be one of those. It
      // doesn't — `Origin` on a fetch() is always the origin of the DOCUMENT
      // RUNNING THE SCRIPT, not whatever iframes it. That document is our own
      // admin page, served from the CloudFront distribution in
      // infra/lib/api-stack.ts — confirmed from a real failing preflight's
      // `Origin` header, not assumed. No wildcard — a leaked presigned URL is
      // already bounded to one object and 5 minutes (upload endpoint's TTL);
      // it should not also be usable from anywhere.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [`https://${props.distributionDomain}`],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: "archive-raw",
          prefix: "raw/",
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // NOTE: the widget asset bucket deliberately lives in the API stack, not
    // here. Origin Access Control attaches a bucket policy referencing the
    // CloudFront distribution, so a bucket here would make Data depend on Api
    // while Api already depends on Data — a genuine dependency cycle.
    //
    // Moving it is the correct fix rather than a workaround: this stack is for
    // STATE, and the widget bundle is build output, rebuildable from source and
    // redeployed on the same cadence as the API.

    // ---- Secrets ----------------------------------------------------------
    // Created EMPTY. Values are set once, out of band, by a human.
    //
    // ⚠️ Never put a secret value in CDK. It would land in the CloudFormation
    // template, in the CDK asset bucket, and in every CI log that runs a diff.
    const secret = (name: string, description: string) =>
      new secretsmanager.Secret(this, name, {
        secretName: `nailzify/${envName}/${name}`,
        description,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

    this.shopifyProxySecret = secret(
      "shopify-proxy-secret",
      "Shopify app API secret key (Client secret). Verifies inbound App Proxy HMAC.",
    );
    this.shopifyStorefrontSecret = secret(
      "shopify-storefront-token",
      "Shopify Storefront API access token. Outbound product hydration. Read-only scope.",
    );
    this.pineconeSecret = secret("pinecone-api-key", "Pinecone Serverless API key.");

    // ---- Outputs ----------------------------------------------------------
    new cdk.CfnOutput(this, "TableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "DocumentsBucketName", { value: this.documentsBucket.bucketName });
  }
}
