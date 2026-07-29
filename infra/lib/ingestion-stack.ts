/**
 * Ingestion stack — the document bucket and the indexing Lambda.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN STACK
 * ============================================================================
 *
 * Not because it is large, but because its BLAST RADIUS is different. The API
 * stack is deployed on every change to the chat path and holds nothing that
 * cannot be rebuilt. This stack owns the document bucket — the store's actual
 * policy documents — which must survive a bad deploy of unrelated code.
 *
 * Splitting by "what happens when this is destroyed?" rather than by "what
 * belongs together conceptually?" is the rule that has kept the other two stacks
 * useful (docs/09-deployment.md §9.2).
 *
 * ============================================================================
 * NO STEP FUNCTIONS
 * ============================================================================
 *
 * docs/03-ingestion.md specified a state machine. Measured against the real
 * corpus the whole job is two Bedrock calls and a few seconds. The thresholds
 * at which the state machine earns its place are written down in
 * services/ingestion/src/handler.ts, next to the code it would replace.
 */

import * as cdk from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export interface IngestionStackProps extends cdk.StackProps {
  readonly envName: string;
  readonly table: dynamodb.Table;
  readonly storefrontSecret: secretsmanager.Secret;
  readonly pineconeSecret: secretsmanager.Secret;
  readonly shopDomain: string;
  readonly storefrontDomain: string;
  readonly pineconeIndex: string;
  readonly shopifyApiVersion: string;
  readonly embedModelId: string;
}

/** Where documents are uploaded. Anything outside it is ignored. */
const DOCUMENT_PREFIX = "documents/";

export class IngestionStack extends cdk.Stack {
  readonly documentBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const isProd = envName === "prod";

    // ---- Document bucket --------------------------------------------------
    this.documentBucket = new s3.Bucket(this, "DocumentBucket", {
      bucketName: `nailzify-${envName}-documents-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,

      // ⚠️ VERSIONING IS THE UNDO BUTTON. These are the store's real policy
      // documents, edited by a human through the console. Overwriting the return
      // policy with a truncated file is a plausible Tuesday, and without
      // versioning the previous text is simply gone — including from the index,
      // which re-ingests whatever it now finds.
      versioned: true,

      // Source documents, not rebuildable artifacts. RETAIN in prod means a
      // `cdk destroy` cannot take the policies with it.
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,

      lifecycleRules: [
        {
          // Old versions are an undo buffer, not an archive. Keeping them
          // forever is a quiet cost leak on a versioned bucket.
          noncurrentVersionExpiration: cdk.Duration.days(90),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ---- Lambda -----------------------------------------------------------
    const ingestFn = new nodejs.NodejsFunction(this, "IngestionHandler", {
      functionName: `nailzify-${envName}-ingestion`,
      entry: path.join(repoRoot, "services/ingestion/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,

      // Higher than the chat function: this one holds the whole catalogue and
      // every chunk in memory at once while batching embeddings.
      memorySize: 1536,

      // Generous but bounded. The job takes seconds today; a timeout here means
      // something is wrong, and the right response is to fail and alarm rather
      // than burn 15 minutes of billed time retrying inside one invocation.
      timeout: cdk.Duration.minutes(5),

      // ⚠️ ONE AT A TIME. Two concurrent runs would race on the same vectors and
      // the same DynamoDB state — one deleting a document's chunks while the
      // other writes them. Uploading three files at once fires three
      // notifications, so this is the normal case, not an edge case.
      reservedConcurrentExecutions: 1,

      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        format: nodejs.OutputFormat.ESM,
        // The AWS SDK v3 is NOT preinstalled in the Node 22 runtime. Marking it
        // external produces a Lambda that fails at runtime with module-not-found.
        externalModules: [],
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },

      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        NAILZIFY_ENV: envName,
        TABLE_NAME: props.table.tableName,
        DOCUMENT_BUCKET: this.documentBucket.bucketName,
        DOCUMENT_PREFIX,
        SHOP_DOMAIN: props.shopDomain,
        STOREFRONT_DOMAIN: props.storefrontDomain,
        SHOPIFY_API_VERSION: props.shopifyApiVersion,
        PINECONE_INDEX: props.pineconeIndex,
        PINECONE_SECRET_ARN: props.pineconeSecret.secretArn,
        STOREFRONT_SECRET_ARN: props.storefrontSecret.secretArn,
      },

      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, "IngestionHandlerLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-ingestion`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ---- IAM --------------------------------------------------------------
    props.table.grantReadWriteData(ingestFn);
    props.pineconeSecret.grantRead(ingestFn);
    props.storefrontSecret.grantRead(ingestFn);

    // READ ONLY on the bucket. This function indexes documents; it has no reason
    // to write or delete one, and a bug that could rewrite the store's return
    // policy is a much worse failure than one that cannot index it.
    this.documentBucket.grantRead(ingestFn);

    // Embedding only. No chat model, no streaming action — this function has no
    // reason to invoke a generative model, and IAM is where that is enforced
    // rather than by nobody having written the code yet.
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${props.embedModelId.replace(/^(us|global)\./, "")}`,
        ],
      }),
    );

    // ---- Trigger 1: a document changed ------------------------------------
    for (const eventType of [
      s3.EventType.OBJECT_CREATED,
      // Without this, deleting a document leaves its vectors behind and the bot
      // keeps quoting a policy the store no longer has.
      s3.EventType.OBJECT_REMOVED,
    ]) {
      this.documentBucket.addEventNotification(
        eventType,
        new s3n.LambdaDestination(ingestFn),
        { prefix: DOCUMENT_PREFIX },
      );
    }

    // ---- Trigger 2: nightly catalogue resync ------------------------------
    //
    // Shopify has product webhooks, and they are the right long-term answer for
    // freshness. A schedule is the right FIRST answer: it needs no webhook
    // registration, no HMAC verification endpoint, and no replay handling, and
    // it self-heals — a missed webhook costs at most one day, whereas a missed
    // webhook with no schedule behind it is permanent drift.
    new events.Rule(this, "NightlyProductSync", {
      ruleName: `nailzify-${envName}-product-sync`,
      description: "Reindex the Shopify catalogue and reconcile deleted products.",
      // 03:00 UTC — outside US and UK shopping hours, so a throttled Bedrock
      // call competes with nobody.
      schedule: events.Schedule.cron({ minute: "0", hour: "3" }),
      targets: [
        new targets.LambdaFunction(ingestFn, {
          event: events.RuleTargetInput.fromObject({ mode: "all" }),
          // A failed run retries twice, then goes to the DLQ. Without a DLQ the
          // only evidence of a failed 03:00 job is its absence from the logs.
          retryAttempts: 2,
        }),
      ],
    });

    new cdk.CfnOutput(this, "DocumentBucketName", {
      value: this.documentBucket.bucketName,
      description: `Upload documents under ${DOCUMENT_PREFIX} to index them.`,
    });
  }
}
