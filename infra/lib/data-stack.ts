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
}

export class DataStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly documentsBucket: s3.Bucket;
  readonly widgetBucket: s3.Bucket;
  readonly shopifyProxySecret: secretsmanager.Secret;
  readonly shopifyStorefrontSecret: secretsmanager.Secret;
  readonly pineconeSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const isProd = envName === "prod";

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

    // Backs "every session for this customer", which is how a GDPR erasure
    // request is serviced. Only signed-in sessions carry the key, so the index
    // stays small.
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      // Only the attributes the lookup needs. A GSI is a full copy of whatever
      // you project, with its own write cost — ALL is rarely the right answer.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["sessionId", "createdAt"],
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

    // ---- Widget assets ----------------------------------------------------
    this.widgetBucket = new s3.Bucket(this, "WidgetBucket", {
      bucketName: `nailzify-${envName}-widget-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Served through CloudFront with Origin Access Control. Public-access
      // misconfiguration is the most common cloud data leak; the bucket itself
      // is never reachable.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Rebuildable from source, so destroying it in dev is harmless.
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

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
    new cdk.CfnOutput(this, "WidgetBucketName", { value: this.widgetBucket.bucketName });
  }
}
