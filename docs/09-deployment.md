# Phase 9 — Deployment Architecture

## 9.1 Infrastructure as Code: AWS CDK

**Why CDK.** Your team writes TypeScript. CDK lets the infrastructure be TypeScript too —
same language, same tooling, same tests, real types and autocomplete for every AWS
resource. More importantly, CDK's L2 constructs apply sane defaults: `new
s3.Bucket(this, "Docs")` gets encryption, blocked public access, and SSL-only policy
without you remembering to ask. That's dozens of security decisions made correctly by
default.

**Alternatives, honestly:**

| Tool | When it wins |
|---|---|
| **Terraform / OpenTofu** | Multi-cloud, or your org already standardizes on it. Better state management and a genuinely better plan/diff. Costs you a second language (HCL). |
| **AWS SAM** | Simpler for pure serverless, great local invoke story. Hits a ceiling once you need CloudFront + Step Functions + WAF wired together. |
| **SST** | Excellent DX for exactly this stack, live Lambda debugging. Smaller ecosystem, more opinionated. |
| **Pulumi** | CDK's idea, multi-cloud. Fine choice; smaller community than either. |
| Console clicking | Never. Undocumented, unreproducible, undiffable. |

**Decision: CDK**, because we're AWS-only and TypeScript-native. If you later go
multi-cloud, Terraform.

---

## 9.2 Stack decomposition

Split by **lifecycle and blast radius**, not by service type. Things that change together
and things whose deletion would be catastrophic should be separated.

```
NailzifyDataStack          ← stateful. Rarely changes. RETAIN on delete.
  • DynamoDB table (PITR on)
  • S3 buckets (versioned)
  • Secrets Manager secrets (values set out-of-band, never in code)

NailzifyIngestionStack     ← changes when the pipeline changes
  • Step Functions state machine
  • extract / chunk / embed / index / verify Lambdas
  • EventBridge rules + Scheduler
  • SQS DLQ

NailzifyApiStack           ← changes most often (every code deploy)
  • chat Lambda + Function URL (RESPONSE_STREAM)
  • CloudFront distribution + WAF WebACL
  • IAM roles

NailzifyWidgetStack        ← independent frontend deploys
  • widget S3 bucket + OAC
  • CloudFront invalidation

NailzifyObservabilityStack ← dashboards, alarms, log groups
```

**Why the split earns its keep:** you deploy `ApiStack` twenty times a week and
`DataStack` twice a year. Keeping them separate means a routine API deploy can never
propose a change to a table containing customer conversations. CloudFormation *will*
happily replace a DynamoDB table if a property change requires it — the separation, plus
`RemovalPolicy.RETAIN`, is what stops that from being a possibility.

```ts
new dynamodb.Table(this, "AppTable", {
  // ...
  removalPolicy: cdk.RemovalPolicy.RETAIN,        // never auto-delete customer data
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
```

Cross-stack references pass by explicit props, not `Fn::ImportValue` — exported values
create deletion locks between stacks that are painful to unwind.

---

## 9.3 Environments

| Env | Account | Purpose |
|---|---|---|
| `dev` | Same account, `dev-` prefix | Fast iteration, real AWS services, dummy Shopify dev store |
| `staging` | Ideally a separate account | Pre-prod verification, Shopify dev store, prod-shaped data |
| `prod` | Separate account (target state) | Live storefront |

**Start with prefixed resources in one account.** Separate AWS accounts is the correct
end state — it gives hard blast-radius isolation and clean cost attribution — but AWS
Organizations setup is a real project. Don't let it block shipping. Migrate when the
system matters enough to justify it, and know that's the direction.

Isolation *within* one account:
- Resource prefixes: `nailzify-dev-app`, `nailzify-prod-app`
- Separate Pinecone namespaces: `knowledge-dev` / `knowledge-prod`
- Separate secrets: `nailzify/dev/*`, `nailzify/prod/*`
- IAM policies scoped to prefixed ARNs, so a dev Lambda cannot read prod data

```ts
// infra/bin/app.ts
const app = new cdk.App();
for (const env of ["dev", "prod"] as const) {
  const data = new DataStack(app, `Nailzify-${env}-Data`, { env });
  new IngestionStack(app, `Nailzify-${env}-Ingestion`, { env, table: data.table, docs: data.docsBucket });
  new ApiStack(app, `Nailzify-${env}-Api`, { env, table: data.table });
}
```

---

## 9.4 Lambda packaging

```ts
new nodejs.NodejsFunction(this, "ChatHandler", {
  entry: "services/api/src/handler.ts",
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,        // ~20% cheaper, faster
  memorySize: 1024,
  timeout: cdk.Duration.seconds(60),
  bundling: {
    minify: true,
    sourceMap: true,                                // readable stack traces
    target: "node22",
    externalModules: [],                            // bundle everything; v3 SDK is not preinstalled
    format: nodejs.OutputFormat.ESM,
  },
  environment: { NODE_OPTIONS: "--enable-source-maps", ...config },
  tracing: lambda.Tracing.ACTIVE,                   // X-Ray
  logRetention: logs.RetentionDays.ONE_MONTH,       // default is FOREVER — a silent cost leak
});
```

Two things people get wrong here:

- **`externalModules: []`.** The AWS SDK v3 is *not* preinstalled in the Node 22 runtime
  the way v2 was in older runtimes. Marking it external produces a Lambda that fails at
  runtime with a module-not-found error. Bundle it.
- **`logRetention`.** CloudWatch's default is "never expire." At $0.03/GB/month stored
  forever, this is the classic quiet AWS cost leak. Set it explicitly on every function.

---

## 9.5 Streaming Function URL + CloudFront

The wiring that makes token streaming work (Phase 5.9):

```ts
const url = chatFn.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.AWS_IAM,     // CloudFront signs with OAC
  invokeMode: lambda.InvokeMode.RESPONSE_STREAM,    // ← the critical line
});

const distribution = new cloudfront.Distribution(this, "Cdn", {
  defaultBehavior: {                                 // widget assets
    origin: origins.S3BucketOrigin.withOriginAccessControl(widgetBucket),
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  additionalBehaviors: {
    "/api/*": {
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(url),
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,        // never cache chat
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    },
  },
  webAclId: webAcl.attrArn,
});
```

**`authType: AWS_IAM` + Origin Access Control** means the Function URL is not publicly
callable — only CloudFront, with a signed request, can invoke it. Without this, anyone who
discovers the raw Function URL bypasses WAF entirely and can run up your Bedrock bill
directly. It's a one-line difference between "protected" and "an open LLM endpoint on the
internet."

`CACHING_DISABLED` on `/api/*` matters too: caching a chat response would serve one
customer's answer to another. Not a hypothetical — it's a straightforward misconfiguration.

---

## 9.6 Deployment strategy

### Backend — gradual traffic shift

```ts
const alias = new lambda.Alias(this, "Live", { aliasName: "live", version: chatFn.currentVersion });

new codedeploy.LambdaDeploymentGroup(this, "Deploy", {
  alias,
  deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
  alarms: [errorRateAlarm, latencyP99Alarm],       // auto-rollback triggers
});
```

10% of traffic to the new version for 5 minutes. If the error-rate or latency alarm fires,
CodeDeploy rolls back automatically. **Wire the alarms** — a deployment strategy with no
alarms is just a slow deployment.

### Frontend — content hashing, no invalidation race

```
nailzify-widget.abc123.js    ← content-hashed, Cache-Control: immutable, 1 year
nailzify-widget.js           ← thin loader, Cache-Control: max-age=300
```

The loader is short-cached and points at the hashed bundle. New deploys upload a new hash
and update the loader. No CloudFront invalidation needed for the big file, and rollback is
just pointing the loader back. Invalidations are slow, cost money past the free tier, and
race with in-flight requests — this pattern avoids all three.

### Prompt and retrieval changes

**Treat them as deployments, because they are.** Version the system prompt, hash it into
telemetry, and gate changes on the eval suite (Phase 7.8). A prompt edit can regress
answer quality as badly as a code bug, and it's invisible without evals.

```ts
export const SYSTEM_PROMPT_VERSION = "2026-07-26.3";
// logged on every turn → correlate quality metrics to prompt versions
```

---

## 9.7 Order of operations

Stack dependencies are real. Deploy in order:

```
1. DataStack           (tables, buckets, secret placeholders)
2. [manual, once]      populate secret VALUES — never in code, never in CI logs
3. IngestionStack
4. ApiStack
5. WidgetStack
6. ObservabilityStack
7. [manual, once]      configure Shopify App Proxy → CloudFront domain
```

Steps 2 and 7 are deliberately manual and deliberately one-time. Secret values in a CI
pipeline end up in logs eventually. Set them once with the CLI or console.

---

## 9.8 Rollback

| Broke | Recovery | Time |
|---|---|---|
| Lambda code | CodeDeploy auto-rollback, or shift the alias to the previous version | < 1 min |
| Widget | Point the loader at the previous hashed bundle | < 5 min (loader TTL) |
| Prompt | Deploy the previous prompt version | < 2 min |
| Infrastructure | `cdk deploy` from the previous git tag | 5–15 min |
| Bad ingestion | `deleteByFilter({ documentId })` + re-ingest the prior document version from S3 | ~10 min |
| Data corruption | DynamoDB PITR restore to a timestamp | 20–60 min |

**Practice the DynamoDB restore before you need it.** A recovery procedure you've never
executed is a hypothesis, not a plan.

---

## 9.9 Region and DR

Single region: **`us-east-1`**. Reasons, in order: widest Bedrock model availability
(confirmed in your account), CloudFront/WAF control-plane lives there, and Pinecone
Serverless can be co-located to shave ~30 ms off every vector query.

**No multi-region for now, deliberately.** Multi-region active-active means solving
DynamoDB global tables, cross-region vector replication, and split-brain session state —
weeks of work for a chatbot whose worst-case outage is "customers use the contact form for
a few hours." Revisit if this becomes revenue-critical.

What we *do* have: S3 cross-region replication for source documents, and a documented
recovery path (redeploy the CDK app to another region, re-run ingestion from replicated S3).
RTO measured in hours. Appropriate to the risk.

---

Next: [Phase 10 — Operations](10-operations.md)
