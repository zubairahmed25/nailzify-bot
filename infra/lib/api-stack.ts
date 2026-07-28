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
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
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
        STOREFRONT_SECRET_ARN: props.storefrontSecret.secretArn,
        PINECONE_SECRET_ARN: props.pineconeSecret.secretArn,
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

    // ---- Streaming Function URL ------------------------------------------
    const functionUrl = chatFn.addFunctionUrl({
      // ⚠️ NOT `NONE`. With AWS_IAM only CloudFront (via OAC) can invoke this.
      // A public Function URL bypasses WAF entirely and lets anyone bill Bedrock
      // directly — an open LLM endpoint on the internet.
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
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
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl),
          // ⚠️ Caching a chat response would serve one customer's answer to
          // another. Not hypothetical — just a misconfiguration.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // The signature covers the query string, so it must reach the origin
          // intact or every request fails verification.
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
    new cdk.CfnOutput(this, "WidgetBucketName", { value: this.widgetBucket.bucketName });
  }
}
