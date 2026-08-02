/**
 * Ingestion stack — the document bucket and the indexing Lambda.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN STACK
 * ============================================================================
 *
 * Not because it is large, but because its BLAST RADIUS is different. This stack
 * holds only compute and rules — everything in it can be destroyed and rebuilt
 * from source. The documents themselves live in the DATA stack, with RETAIN on
 * them, because they are the one thing here that cannot be regenerated.
 *
 * An earlier version of this file created its own document bucket with the same
 * name as the Data stack's. The deploy failed with "already exists", which was
 * the correct outcome — splitting by "what happens when this is destroyed?"
 * only works if each thing has exactly one owner (docs/09-deployment.md §9.2).
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
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export interface IngestionStackProps extends cdk.StackProps {
  readonly envName: string;
  readonly table: dynamodb.Table;
  /**
   * Owned by the DATA stack, not this one.
   *
   * It holds the store's real policy documents — state, with RETAIN on it — and
   * the rule for splitting these stacks is blast radius: what must survive a bad
   * deploy of unrelated code lives in Data. An earlier version of this file
   * created its own bucket with the identical name and the deploy failed with
   * "already exists", which was the right outcome.
   */
  readonly documentsBucket: s3.Bucket;
  readonly storefrontSecret: secretsmanager.Secret;
  readonly pineconeSecret: secretsmanager.Secret;
  readonly shopDomain: string;
  readonly storefrontDomain: string;
  readonly pineconeIndex: string;
  readonly shopifyApiVersion: string;
  readonly embedModelId: string;
  /**
   * Same model ids the chat Lambda uses, granted here for a different reason:
   * classifying an admin-uploaded PDF (title, category, section headings)
   * before it enters the same chunk/embed pipeline every other document goes
   * through. See services/ingestion/src/composition-root.ts for why `judge`
   * needs no separate id — it already equals `chat` in both model maps.
   */
  readonly chatModelId: string;
  readonly fastModelId: string;
}

/**
 * Where documents are uploaded. Anything outside it is ignored.
 *
 * Must match the `raw/` lifecycle rule already on the bucket in the Data stack —
 * a different prefix here would mean uploads that are never archived and, worse,
 * a trigger that never fires.
 */
const DOCUMENT_PREFIX = "raw/";

export class IngestionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);
    const { envName } = props;

    // Opt-in, because a new AWS account cannot satisfy it. See the note below.
    const reserveConcurrency =
      this.node.tryGetContext("reserveIngestionConcurrency") === "true";

    const documentsBucket = props.documentsBucket;

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

      // ⚠️ WANTS TO BE 1, AND CANNOT BE ON A NEW AWS ACCOUNT.
      //
      // One at a time is correct here: two concurrent runs can race on the same
      // document — one deleting its chunks while the other writes them — and
      // uploading three files at once fires three events, so it is the normal
      // case rather than an edge case.
      //
      // But a fresh account has a TOTAL Lambda concurrency of 10, and AWS
      // requires at least 10 to remain unreserved. Any reservation whatsoever is
      // rejected:
      //
      //   Specified ReservedConcurrentExecutions for function decreases
      //   account's UnreservedConcurrentExecution below its minimum value of [10]
      //
      // So it is opt-in, and off by default. Once the account quota is raised
      // (Service Quotas -> Lambda -> "Concurrent executions"), redeploy with:
      //
      //   npx cdk deploy --all -c reserveIngestionConcurrency=true
      //
      // WHAT THE RISK ACTUALLY IS while it is off: chunk ids are deterministic
      // and re-ingest is idempotent, so two runs over the same document converge
      // on the same end state. The exposure is the window where one run's delete
      // lands after the other's upsert, leaving that document briefly missing
      // from the index until the next run. Bounded and self-healing — not
      // nothing, but not a reason to block the deploy.
      ...(reserveConcurrency ? { reservedConcurrentExecutions: 1 } : {}),

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
        DOCUMENT_BUCKET: documentsBucket.bucketName,
        DOCUMENT_PREFIX,
        SHOP_DOMAIN: props.shopDomain,
        STOREFRONT_DOMAIN: props.storefrontDomain,
        SHOPIFY_API_VERSION: props.shopifyApiVersion,
        PINECONE_INDEX: props.pineconeIndex,
        PINECONE_SECRET_ARN: props.pineconeSecret.secretArn,
        STOREFRONT_SECRET_ARN: props.storefrontSecret.secretArn,
        CHAT_MODEL_ID: props.chatModelId,
        FAST_MODEL_ID: props.fastModelId,
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
    documentsBucket.grantRead(ingestFn);

    // ⚠️ NO LONGER "EMBEDDING ONLY" — that was true until PDF classification
    // needed a real generative call. Still deliberately narrow: InvokeModel
    // only, never InvokeModelWithResponseStream — this function classifies a
    // document once and returns, it never streams a customer-facing answer,
    // and the chat Lambda's grant is what covers that action.
    //
    // The chat-model grant needs BOTH ARN forms, same as the chat Lambda: the
    // inference-profile ARN (what the code actually calls) and the underlying
    // foundation-model ARN (what Bedrock checks permissions against under the
    // hood). Missing either one is a ValidationException that does not say
    // which permission is missing.
    const classifyModelArns = [
      `arn:aws:bedrock:*:${this.account}:inference-profile/${props.chatModelId}`,
      `arn:aws:bedrock:*::foundation-model/${props.chatModelId.replace(/^(us|global)\./, "")}`,
    ];

    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${props.embedModelId.replace(/^(us|global)\./, "")}`,
          ...classifyModelArns,
        ],
      }),
    );

    // ---- Trigger 1: a document changed ------------------------------------
    //
    // Via EventBridge rather than a bucket notification, because the bucket
    // already has `eventBridgeEnabled: true` and lives in another stack.
    // Attaching a notification to a cross-stack bucket provisions a custom
    // resource that mutates it from here — two stacks writing one bucket's
    // configuration, and a deploy-order hazard for no gain.
    //
    // ⚠️ THE EVENT SHAPE IS DIFFERENT. EventBridge sends `detail.bucket.name`
    // and `detail.object.key`; a bucket notification sends `Records[]`. The
    // handler accepts both, because getting this wrong produces a Lambda that
    // is invoked correctly and then does nothing.
    new events.Rule(this, "DocumentChanged", {
      ruleName: `nailzify-${envName}-document-changed`,
      description: "Reindex or purge a document when its S3 object changes.",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created", "Object Deleted"],
        detail: {
          bucket: { name: [documentsBucket.bucketName] },
          object: { key: [{ prefix: DOCUMENT_PREFIX }] },
        },
      },
      targets: [new targets.LambdaFunction(ingestFn, { retryAttempts: 2 })],
    });

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

    new cdk.CfnOutput(this, "UploadDocumentsTo", {
      value: `s3://${documentsBucket.bucketName}/${DOCUMENT_PREFIX}`,
      description: "Upload markdown here to index it. Deleting an object purges its vectors.",
    });
  }
}
