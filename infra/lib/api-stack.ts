/**
 * API stack — the chat Lambda and everything in front of it.
 *
 * Deployed constantly, holds nothing stateful. That is the point of the split.
 */

import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export interface ApiStackProps extends cdk.StackProps {
  readonly envName: string;
  readonly table: dynamodb.Table;
  readonly proxySecret: secretsmanager.Secret;
  readonly storefrontSecret: secretsmanager.Secret;
  readonly pineconeSecret: secretsmanager.Secret;
  readonly brevoApiKeySecret: secretsmanager.Secret;
  readonly brevoWebhookSecret: secretsmanager.Secret;
  readonly resendApiKeySecret: secretsmanager.Secret;
  readonly resendWebhookSecret: secretsmanager.Secret;
  readonly shopDomain: string;
  readonly storefrontDomain: string;
  readonly pineconeIndex: string;
  /** Pinned Shopify API version, e.g. `2025-10`. Retires after ~12 months. */
  readonly shopifyApiVersion: string;
  /** Inference-profile IDs. Bare model IDs are rejected — see llm-client.ts. */
  readonly chatModelId: string;
  readonly fastModelId: string;
  readonly embedModelId: string;
  readonly rerankModelId: string;
  /**
   * Owned by the DATA stack. The admin Lambda presigns PUT URLs into it and
   * deletes objects when a merchant removes an upload — see
   * services/admin/src/composition-root.ts.
   */
  readonly documentsBucket: s3.Bucket;
  /**
   * The app's Client ID (API key) — NOT secret, unlike `proxySecret`. It is
   * baked into the embedded admin page's frontend bundle by Shopify's own
   * tooling, so treating it as sensitive here would be theatre. Used only to
   * check the `aud` claim on a session token (services/admin/src/security/verify-session-token.ts).
   */
  readonly shopifyApiKey: string;
  readonly merchantSupportRecipients: string;
  readonly sesFromAddress: string;
  readonly sesIdentityDomain: string;
  readonly ticketEmailProvider: string;
  readonly brevoFromAddress: string;
  readonly brevoInboundSpamScoreMax: string;
  readonly resendFromAddress: string;
  readonly adminAppUrl: string;
  readonly supportReplyDomain: string;
  readonly ticketEmailBucket: s3.Bucket;
  readonly customerOrderKey: kms.Key;
  readonly distributionDomain: string;
  readonly customerOrderReturnOrigin: string;
  readonly customerOrderLookupEnabled: boolean;
}

export class ApiStack extends cdk.Stack {
  readonly distributionDomainName: string;
  readonly widgetBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const isProd = envName === "prod";

    // ---- Widget assets ----------------------------------------------------
    // Lives here rather than in the data stack because Origin Access Control
    // attaches a bucket policy referencing the distribution below. Owning both
    // sides in one stack avoids a cross-stack dependency cycle — and is more
    // honest anyway, since a build artifact is not state.
    this.widgetBucket = new s3.Bucket(this, "WidgetBucket", {
      bucketName: `nailzify-${envName}-widget-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Served through CloudFront with OAC. Public-access misconfiguration is
      // the most common cloud data leak; the bucket itself is never reachable.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Rebuildable from source, so destroying it outside prod is harmless.
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ---- Lambda -----------------------------------------------------------
    const chatFn = new nodejs.NodejsFunction(this, "ChatHandler", {
      functionName: `nailzify-${envName}-chat`,
      entry: path.join(repoRoot, "services/api/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,

      // ~20% cheaper per GB-second than x86 at equal or better Node performance.
      // There is no reason to pick x86 for a new Node Lambda.
      architecture: lambda.Architecture.ARM_64,

      // Lambda allocates CPU proportionally to memory. This function is mostly
      // I/O-bound waiting on Bedrock, but JSON parsing and SSE framing benefit
      // from the extra vCPU share. Tune with Lambda Power Tuning.
      memorySize: 1024,

      // Generous: a tool loop with reranking and a long generation can legitimately
      // run tens of seconds. The customer-facing timeout is CloudFront's, not this.
      timeout: cdk.Duration.seconds(120),

      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        format: nodejs.OutputFormat.ESM,
        // ⚠️ Bundle EVERYTHING. The AWS SDK v3 is NOT preinstalled in the Node
        // 22 runtime the way v2 was in older runtimes — marking it external
        // produces a Lambda that fails at runtime with module-not-found.
        externalModules: [],
        // ESM output in Lambda needs createRequire for any CJS dependency that
        // slips through the bundler.
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },

      environment: {
        /**
         * Bump to force CloudFormation to rewrite the ENTIRE environment block.
         *
         * ⚠️ WHY THIS EXISTS. `aws lambda update-function-configuration
         * --environment` REPLACES every variable rather than merging, so one
         * command run to force a cold start wiped all ten of these and left the
         * function returning 503 "Service is not configured".
         *
         * Redeploying did not fix it. CloudFormation diffs its template against
         * the LAST DEPLOYED TEMPLATE, not against reality — the environment
         * block was unchanged in the template, so it was left alone and the
         * drift persisted. Changing any value in the block forces a full
         * rewrite, which also removes anything added out of band.
         *
         * To correct drift like this again: bump this number and deploy.
         */
        CONFIG_REVISION: "2",
        NODE_OPTIONS: "--enable-source-maps",
        NAILZIFY_ENV: envName,
        TABLE_NAME: props.table.tableName,
        SHOP_DOMAIN: props.shopDomain,
        STOREFRONT_DOMAIN: props.storefrontDomain,
        // ⚠️ Shopify retires API versions after ~12 months. Review this on a
        // calendar reminder — a retired version fails like a bad credential.
        SHOPIFY_API_VERSION: props.shopifyApiVersion,
        PINECONE_INDEX: props.pineconeIndex,
        CHAT_MODEL_ID: props.chatModelId,
        FAST_MODEL_ID: props.fastModelId,
        PROXY_SECRET_ARN: props.proxySecret.secretArn,
        SUPPORT_REPLY_DOMAIN: props.supportReplyDomain,
        STOREFRONT_SECRET_ARN: props.storefrontSecret.secretArn,
        PINECONE_SECRET_ARN: props.pineconeSecret.secretArn,
        MERCHANT_SUPPORT_RECIPIENTS: props.merchantSupportRecipients,
        SHOPIFY_API_KEY: props.shopifyApiKey,
        CUSTOMER_ORDER_LOOKUP_ENABLED: String(props.customerOrderLookupEnabled),
        CUSTOMER_ORDER_AUTH_CALLBACK_URL:
          `https://${props.distributionDomain}/api/customer-orders/auth/callback`,
        CUSTOMER_ORDER_AUTH_RETURN_URL: props.customerOrderReturnOrigin,
        CUSTOMER_ORDER_SESSION_MINUTES: "15",
        CUSTOMER_ORDER_MAX_RECENT: "5",
        CUSTOMER_ORDER_KMS_KEY_ID: props.customerOrderKey.keyArn,
      },

      tracing: lambda.Tracing.ACTIVE,
      // ⚠️ CloudWatch's default is NEVER EXPIRE. At $0.03/GB stored forever this
      // is the classic quiet AWS cost leak. Set it on every function.
      //
      // An explicit LogGroup rather than the deprecated `logRetention` prop —
      // that one provisions a custom resource Lambda just to call PutRetentionPolicy.
      logGroup: new logs.LogGroup(this, "ChatHandlerLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-chat`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ---- IAM: least privilege --------------------------------------------
    // The single highest-leverage security control here. A prompt injection can
    // only do what this role permits, so the role is the real boundary — not the
    // system prompt.
    props.table.grantReadWriteData(chatFn);
    props.proxySecret.grantRead(chatFn);
    props.storefrontSecret.grantRead(chatFn);
    props.pineconeSecret.grantRead(chatFn);
    props.customerOrderKey.grantEncryptDecrypt(chatFn);

    // Scoped to SPECIFIC models, not `bedrock:*` on `*`. An over-broad grant
    // would let a compromised function invoke anything in the account.
    const modelArns = [props.chatModelId, props.fastModelId].map(
      (id) => `arn:aws:bedrock:*:${this.account}:inference-profile/${id}`,
    );
    const foundationArns = [props.embedModelId, props.rerankModelId, props.chatModelId, props.fastModelId]
      .map((id) => `arn:aws:bedrock:*::foundation-model/${id.replace(/^(us|global)\./, "")}`);

    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [...modelArns, ...foundationArns],
      }),
    );

    // ---- Admin Lambda -------------------------------------------------------
    //
    // Behind the embedded admin page, not the storefront. Session-token
    // authenticated (services/admin/src/security/verify-session-token.ts), not
    // App Proxy HMAC — a genuinely different caller. It never touches Bedrock
    // or Pinecone: its entire job is minting a presigned S3 upload URL and
    // reading/writing the `INGEST#UPLOAD` rows the ingestion Lambda already
    // owns. Kept in THIS stack rather than a new one because this is where
    // "everything deployed constantly, in front of the public internet"
    // already lives — a second CloudFront distribution for one small Lambda
    // would be a second WAF, a second domain, and a second thing to keep in
    // sync for no isolation benefit this Lambda's blast radius needs.
    const adminFn = new nodejs.NodejsFunction(this, "AdminHandler", {
      functionName: `nailzify-${envName}-admin`,
      entry: path.join(repoRoot, "services/admin/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),

      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        format: nodejs.OutputFormat.ESM,
        externalModules: [],
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },

      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        NAILZIFY_ENV: envName,
        TABLE_NAME: props.table.tableName,
        DOCUMENT_BUCKET: props.documentsBucket.bucketName,
        SHOP_DOMAIN: props.shopDomain,
        SHOPIFY_API_KEY: props.shopifyApiKey,
        PROXY_SECRET_ARN: props.proxySecret.secretArn,
      },

      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, "AdminHandlerLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-admin`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.table.grantReadWriteData(adminFn);
    props.proxySecret.grantRead(adminFn);
    // PUT (presigned upload URLs) and DELETE (removing an upload) only. No
    // read grant — this Lambda never needs to look inside a document, and a
    // bug here should not be able to exfiltrate one.
    props.documentsBucket.grantPut(adminFn);
    props.documentsBucket.grantDelete(adminFn);

    // ---- Ticket email -----------------------------------------------------
    // Ticket changes commit to DynamoDB first. Stream dispatch then moves each
    // durable outbox record through SQS to the configured email provider, so an email outage cannot make
    // the customer request disappear.
    const notificationDlq = new sqs.Queue(this, "TicketNotificationDlq", {
      queueName: `nailzify-${envName}-ticket-email-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const notificationQueue = new sqs.Queue(this, "TicketNotificationQueue", {
      queueName: `nailzify-${envName}-ticket-email`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(90),
      deadLetterQueue: { queue: notificationDlq, maxReceiveCount: 5 },
    });

    const sesIdentity = new ses.EmailIdentity(this, "TicketEmailIdentity", {
      identity: ses.Identity.domain(props.sesIdentityDomain),
      mailFromDomain: `mail.${props.sesIdentityDomain}`,
    });
    const configurationSet = new ses.ConfigurationSet(this, "TicketEmailConfiguration", {
      configurationSetName: `nailzify-${envName}-tickets`,
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    configurationSet.addEventDestination("TicketDeliveryEvents", {
      destination: ses.EventDestination.eventBus(events.EventBus.fromEventBusName(
        this,
        "DefaultEventBus",
        "default",
      )),
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
      ],
    });

    const dispatcherFn = new nodejs.NodejsFunction(this, "TicketOutboxDispatcher", {
      functionName: `nailzify-${envName}-ticket-outbox`,
      entry: path.join(repoRoot, "services/notifications/src/dispatcher.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: { TICKET_NOTIFICATION_QUEUE_URL: notificationQueue.queueUrl },
      logGroup: new logs.LogGroup(this, "TicketOutboxDispatcherLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-ticket-outbox`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    dispatcherFn.addEventSource(new eventSources.DynamoEventSource(props.table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 25,
      retryAttempts: 3,
      bisectBatchOnError: true,
    }));
    notificationQueue.grantSendMessages(dispatcherFn);

    const emailWorkerFn = new nodejs.NodejsFunction(this, "TicketEmailWorker", {
      functionName: `nailzify-${envName}-ticket-email`,
      entry: path.join(repoRoot, "services/notifications/src/worker.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        TICKET_EMAIL_PROVIDER: props.ticketEmailProvider,
        BREVO_FROM_ADDRESS: props.brevoFromAddress,
        BREVO_API_KEY_SECRET_ARN: props.brevoApiKeySecret.secretArn,
        RESEND_FROM_ADDRESS: props.resendFromAddress,
        RESEND_API_KEY_SECRET_ARN: props.resendApiKeySecret.secretArn,
        SES_FROM_ADDRESS: props.sesFromAddress,
        SES_CONFIGURATION_SET: configurationSet.configurationSetName,
        ADMIN_APP_URL: props.adminAppUrl,
        SUPPORT_REPLY_DOMAIN: props.supportReplyDomain,
        PROXY_SECRET_ARN: props.proxySecret.secretArn,
      },
      logGroup: new logs.LogGroup(this, "TicketEmailWorkerLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-ticket-email`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    emailWorkerFn.addEventSource(new eventSources.SqsEventSource(notificationQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));
    props.table.grantReadWriteData(emailWorkerFn);
    emailWorkerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ses:SendEmail"],
      // SES evaluates identity resources for dynamic recipients as well as the
      // sender. Keep the resource open for customer addresses, but prevent the
      // worker from sending as any identity other than our configured mailbox.
      resources: ["*"],
      conditions: {
        StringEquals: {
          "ses:FromAddress": props.sesFromAddress,
        },
      },
    }));
    props.proxySecret.grantRead(emailWorkerFn);
    props.brevoApiKeySecret.grantRead(emailWorkerFn);
    props.resendApiKeySecret.grantRead(emailWorkerFn);

    const deliveryEventsFn = new nodejs.NodejsFunction(this, "TicketDeliveryEvents", {
      functionName: `nailzify-${envName}-ticket-delivery-events`,
      entry: path.join(repoRoot, "services/notifications/src/delivery-events.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: { TABLE_NAME: props.table.tableName },
      logGroup: new logs.LogGroup(this, "TicketDeliveryEventsLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-ticket-delivery-events`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    props.table.grantReadWriteData(deliveryEventsFn);
    new events.Rule(this, "TicketDeliveryEventRule", {
      eventPattern: {
        source: ["aws.ses"],
        detailType: ["Email Sending Event"],
      },
      targets: [new eventTargets.LambdaFunction(deliveryEventsFn)],
    });

    const inboundFn = new nodejs.NodejsFunction(this, "TicketInboundEmail", {
      functionName: `nailzify-${envName}-ticket-inbound`,
      entry: path.join(repoRoot, "services/notifications/src/inbound.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        TICKET_EMAIL_BUCKET: props.ticketEmailBucket.bucketName,
        PROXY_SECRET_ARN: props.proxySecret.secretArn,
        MERCHANT_SUPPORT_RECIPIENTS: props.merchantSupportRecipients,
      },
      logGroup: new logs.LogGroup(this, "TicketInboundEmailLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-ticket-inbound`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    props.table.grantReadWriteData(inboundFn);
    props.ticketEmailBucket.grantReadWrite(inboundFn);
    props.ticketEmailBucket.grantDelete(inboundFn);
    props.proxySecret.grantRead(inboundFn);

    const brevoWebhookFn = new nodejs.NodejsFunction(this, "BrevoTicketWebhooks", {
      functionName: `nailzify-${envName}-brevo-ticket-webhooks`,
      entry: path.join(repoRoot, "services/notifications/src/brevo-webhook.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        PROXY_SECRET_ARN: props.proxySecret.secretArn,
        BREVO_WEBHOOK_SECRET_ARN: props.brevoWebhookSecret.secretArn,
        BREVO_INBOUND_SPAM_SCORE_MAX: props.brevoInboundSpamScoreMax,
        MERCHANT_SUPPORT_RECIPIENTS: props.merchantSupportRecipients,
      },
      logGroup: new logs.LogGroup(this, "BrevoTicketWebhooksLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-brevo-ticket-webhooks`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    props.table.grantReadWriteData(brevoWebhookFn);
    props.proxySecret.grantRead(brevoWebhookFn);
    props.brevoWebhookSecret.grantRead(brevoWebhookFn);
    const brevoWebhookUrl = brevoWebhookFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    const resendWebhookFn = new nodejs.NodejsFunction(this, "ResendTicketWebhooks", {
      functionName: `nailzify-${envName}-resend-ticket-webhooks`,
      entry: path.join(repoRoot, "services/notifications/src/resend-webhook.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        PROXY_SECRET_ARN: props.proxySecret.secretArn,
        RESEND_API_KEY_SECRET_ARN: props.resendApiKeySecret.secretArn,
        RESEND_WEBHOOK_SECRET_ARN: props.resendWebhookSecret.secretArn,
        MERCHANT_SUPPORT_RECIPIENTS: props.merchantSupportRecipients,
      },
      logGroup: new logs.LogGroup(this, "ResendTicketWebhooksLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-resend-ticket-webhooks`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    props.table.grantReadWriteData(resendWebhookFn);
    props.proxySecret.grantRead(resendWebhookFn);
    props.resendApiKeySecret.grantRead(resendWebhookFn);
    props.resendWebhookSecret.grantRead(resendWebhookFn);
    const resendWebhookUrl = resendWebhookFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    const receiptRules = new ses.ReceiptRuleSet(this, "TicketReceiptRules", {
      receiptRuleSetName: `nailzify-${envName}-ticket-replies`,
      dropSpam: false,
    });
    const ticketReplyRule = receiptRules.addRule("TicketReplies", {
      recipients: [props.supportReplyDomain],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new sesActions.S3({ bucket: props.ticketEmailBucket, objectKeyPrefix: "incoming/" }),
        new sesActions.Lambda({
          function: inboundFn,
          invocationType: sesActions.LambdaInvocationType.EVENT,
        }),
      ],
    });

    const closeSolvedFn = new nodejs.NodejsFunction(this, "CloseSolvedTickets", {
      functionName: `nailzify-${envName}-ticket-close-solved`,
      entry: path.join(repoRoot, "services/notifications/src/close-solved.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      bundling: { minify: true, sourceMap: true, target: "node22", externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        SHOP_DOMAIN: props.shopDomain,
        TICKET_CLOSE_AFTER_DAYS: "7",
      },
      logGroup: new logs.LogGroup(this, "CloseSolvedTicketsLogs", {
        logGroupName: `/aws/lambda/nailzify-${envName}-ticket-close-solved`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    props.table.grantReadWriteData(closeSolvedFn);
    new events.Rule(this, "CloseSolvedTicketsSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new eventTargets.LambdaFunction(closeSolvedFn)],
    });

    const dlqAlarm = new cloudwatch.Alarm(this, "TicketEmailDlqAlarm", {
      alarmName: `nailzify-${envName}-ticket-email-dlq`,
      metric: notificationDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(
      new sns.Topic(this, "TicketOperationsAlerts", {
        topicName: `nailzify-${envName}-ticket-operations`,
        enforceSSL: true,
      }),
    ));

    const adminFunctionUrl = adminFn.addFunctionUrl({
      // Same reasoning as the chat Function URL below: CloudFront cannot sign
      // a PUT/POST body with SigV4 the way AWS_IAM + OAC would require, so
      // this is NONE at the Function URL and relies on the session-token
      // check inside the handler, same shape as the App Proxy HMAC guarding
      // the chat endpoint.
      authType: lambda.FunctionUrlAuthType.NONE,
      // BUFFERED (the default) — nothing here streams. A JSON response in
      // milliseconds needs none of the chat Lambda's RESPONSE_STREAM machinery.
    });

    // ---- Streaming Function URL ------------------------------------------
    const functionUrl = chatFn.addFunctionUrl({
      // ⚠️ THIS WAS AWS_IAM + OAC, AND IT CANNOT WORK. Recorded because the
      // reasoning that produced it is sound and still tempting.
      //
      // AWS_IAM plus CloudFront Origin Access Control is the correct way to keep
      // a Function URL private — for GET traffic. For POST with a body, AWS's
      // own documentation is explicit:
      //
      //   "If you use PUT or POST methods with your Lambda function URL, your
      //    users must compute the SHA256 of the body and include the payload
      //    hash in the x-amz-content-sha256 header. Lambda doesn't support
      //    unsigned payloads."
      //
      // The "user" here is SHOPIFY'S APP PROXY, forwarding a customer's message.
      // It will never attach an AWS-specific header. So every chat request died
      // at the Function URL with a SigV4 mismatch, before reaching our code —
      // observable only as a 403 that reads like a permissions problem.
      //
      // WHAT ACTUALLY GUARDS THIS ENDPOINT, and always did: the Shopify App
      // Proxy HMAC, verified in handler.ts before any work happens. A request
      // without a valid signature is rejected in about a millisecond and never
      // reaches Bedrock. IAM was defence in depth on top of that, not the
      // boundary itself.
      //
      // WHAT IS GENUINELY LOST: the Function URL is now reachable directly, so
      // traffic that finds it bypasses the WAF below. That costs Lambda
      // invocations under a flood — not Bedrock spend, since unsigned requests
      // never get that far. Shopify's traffic still arrives through CloudFront
      // and is still filtered. To close it completely, add a shared secret
      // header on the CloudFront origin and require it in the handler.
      authType: lambda.FunctionUrlAuthType.NONE,
      // ⚠️ THE CRITICAL LINE. Without RESPONSE_STREAM the body is buffered and
      // the customer waits ~4s for the whole answer instead of ~800ms for the
      // first token. API Gateway cannot do this at all.
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ---- WAF --------------------------------------------------------------
    // Must live in us-east-1 for CloudFront regardless of where the app runs.
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `nailzify-${envName}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          // The denial-of-wallet control. Our Lambda calls a metered LLM, so
          // volume from one source is a financial risk, not just a load one.
          name: "RateLimitPerIp",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 300, aggregateKeyType: "IP" },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitPerIp",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "CommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // ---- CloudFront -------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: `Nailzify concierge (${envName})`,
      webAclId: webAcl.attrArn,

      // Widget assets. Content-hashed filenames mean these can cache hard.
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.widgetBucket),
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },

      additionalBehaviors: {
        "/api/*": {
          // Plain origin, NOT withOriginAccessControl(). OAC signs the request
          // with SigV4, which is precisely what the Function URL rejects for a
          // POST body — see the authType note above.
          origin: new origins.FunctionUrlOrigin(functionUrl),
          // ⚠️ Caching a chat response would serve one customer's answer to
          // another. Not hypothetical — just a misconfiguration.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // The signature covers the query string, so it must reach the origin
          // intact or every request fails verification.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        },

        "/admin/api/*": {
          origin: new origins.FunctionUrlOrigin(adminFunctionUrl),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // ⚠️ MUST forward Authorization — that is the entire auth mechanism
          // for this path. ALL_VIEWER_EXCEPT_HOST_HEADER is confirmed by AWS's
          // own docs to include it (unlike CloudFront's default legacy
          // forwarding, which strips it) — the same policy already proven to
          // pass the App Proxy's signed query string through untouched on
          // /api/*. Still worth one real request before relying on this live,
          // same discipline as every other Shopify-facing assumption here.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        },
      },
    });

    this.distributionDomainName = distribution.distributionDomainName;

    new cdk.CfnOutput(this, "DistributionDomain", {
      value: distribution.distributionDomainName,
      description: "Point the Shopify App Proxy at https://<this>/api",
    });
    new cdk.CfnOutput(this, "FunctionName", { value: chatFn.functionName });
    new cdk.CfnOutput(this, "AdminFunctionName", { value: adminFn.functionName });
    new cdk.CfnOutput(this, "WidgetBucketName", { value: this.widgetBucket.bucketName });
    new cdk.CfnOutput(this, "TicketEmailQueueUrl", { value: notificationQueue.queueUrl });
    new cdk.CfnOutput(this, "BrevoDeliveryWebhookUrl", {
      value: `${brevoWebhookUrl.url}delivery`,
      description: "Create the Brevo transactional webhook with bearer authentication at this URL.",
    });
    new cdk.CfnOutput(this, "BrevoInboundWebhookUrl", {
      value: `${brevoWebhookUrl.url}inbound`,
      description: `Create the Brevo inbound webhook for ${props.supportReplyDomain} at this URL.`,
    });
    new cdk.CfnOutput(this, "ResendWebhookUrl", {
      value: resendWebhookUrl.url,
      description: "Create one signed Resend webhook for delivery and received email events at this URL.",
    });
    new cdk.CfnOutput(this, "BrevoReplyMxPrimary", {
      value: "10 inbound1.sendinblue.com.",
      description: `Publish as the first MX record for ${props.supportReplyDomain}`,
    });
    new cdk.CfnOutput(this, "BrevoReplyMxSecondary", {
      value: "20 inbound2.sendinblue.com.",
      description: `Publish as the second MX record for ${props.supportReplyDomain}`,
    });
    new cdk.CfnOutput(this, "TicketEmailIdentityArn", { value: sesIdentity.emailIdentityArn });
    new cdk.CfnOutput(this, "TicketReplyMxValue", {
      value: `10 inbound-smtp.${this.region}.amazonaws.com`,
      description: `Publish as the MX record for ${props.supportReplyDomain}`,
    });
    new cdk.CfnOutput(this, "TicketReceiptRuleSetName", {
      value: receiptRules.receiptRuleSetName,
      description: "Check existing SES receiving rules before activating this rule set.",
    });
  }
}
