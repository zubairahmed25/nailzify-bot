# Phase 11 — CI/CD Pipeline

## 11.1 GitHub Actions vs. the alternatives

You asked whether there's something better than GitHub Actions. Honest comparison:

| Option | Verdict |
|---|---|
| **GitHub Actions** | ✅ **Chosen.** Code already lives on GitHub, so zero extra integration. Generous free tier for public/small private repos. **Native OIDC federation with AWS** — the deciding factor (§11.2). Huge marketplace. |
| AWS CodePipeline + CodeBuild | Deepest AWS integration, IAM-native, and CodeDeploy hooks in nicely. But the developer experience is noticeably worse, YAML is more verbose, and you're now maintaining CI infrastructure *as* infrastructure. Reach for it if you have a hard "no third-party CI touches our account" requirement — but note OIDC already solves the underlying concern. |
| GitLab CI | Excellent product. Only if you're already on GitLab. |
| Buildkite / CircleCI | Better at scale and for complex fan-out. Extra vendor, extra cost, not justified here. |
| Vercel / Netlify | Great for the widget, useless for CDK + Lambda. Splits your pipeline in two. |

**Recommendation: GitHub Actions.** For a project of this size, the marginal value of
anything else doesn't cover the integration cost — and OIDC removes the one genuine
security argument against third-party CI.

---

## 11.2 OIDC — no AWS keys in GitHub, ever

**The wrong way** (still depressingly common): create an IAM user, generate an access key,
paste it into GitHub Secrets. That key is long-lived, has no expiry, works from anywhere,
and lives in a system outside your AWS account. Leaked AWS keys in CI are one of the most
common cloud breach vectors, and rotating them is a manual chore nobody does.

**The right way:** OIDC federation. GitHub Actions presents a signed identity token; AWS
verifies it against GitHub's public keys and issues **temporary** credentials scoped to a
role. Nothing to leak, nothing to rotate, and the trust policy can pin *which repository
and which branch* may assume the role.

```
GitHub Actions job
      │ requests an OIDC token from GitHub
      ▼
token.actions.githubusercontent.com  (signed JWT: repo, ref, environment)
      │
      ▼
AWS STS AssumeRoleWithWebIdentity
      │ validates signature + trust policy conditions
      ▼
Temporary credentials (1 hour) → cdk deploy
```

**One-time AWS setup** (run once, from your admin identity):

```bash
# 1. Register GitHub as an OIDC identity provider
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com

# 2. Create the deploy role with a scoped trust policy
aws iam create-role \
  --role-name nailzify-github-deploy \
  --assume-role-policy-document file://infra/iam/github-oidc-trust.json
```

The trust policy is where the security lives:

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::984844735070:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        // Pin to YOUR repo and specific refs. Without this, ANY GitHub repo
        // on the internet can assume this role. This line is the whole control.
        "token.actions.githubusercontent.com:sub": "repo:<your-org>/nailzify-bot:ref:refs/heads/main"
      }
    }
  }]
}
```

> ⚠️ **The `sub` condition is not optional.** A trust policy that only checks `aud` is
> assumable by any GitHub Actions workflow anywhere. This is a well-known misconfiguration
> and it has caused real breaches. Pin the repo, and pin the ref or environment.

For production, add a second role gated on
`repo:<org>/nailzify-bot:environment:production` and use a GitHub Environment with
required reviewers — so a prod deploy needs a human approval.

---

## 11.3 Pipeline stages

```
Pull request
  ├─ lint + typecheck                     ~40 s
  ├─ unit tests                           ~30 s
  ├─ architecture boundary check          ~5 s   ← core must not import AWS
  ├─ retrieval eval (golden set)          ~90 s  ← recall@5 must not regress
  ├─ widget bundle-size budget            ~20 s  ← fail if > 25 KB gzipped
  ├─ cdk synth + cdk-nag                  ~60 s  ← security rules on IaC
  └─ secret scanning (gitleaks)           ~15 s

Merge to main
  ├─ everything above
  ├─ integration tests (dev AWS)          ~3 min
  ├─ deploy → dev                         ~5 min
  ├─ smoke tests against dev              ~1 min
  └─ generation eval (LLM judge)          ~4 min

Manual promotion (GitHub Environment, required reviewer)
  ├─ deploy → prod (canary 10% / 5 min)
  ├─ smoke tests against prod
  └─ auto-rollback on alarm
```

**The two gates that are unusual and worth defending:**

- **Retrieval eval on every PR.** Cheap (no LLM calls — just embed + search + compare),
  deterministic, fast. It catches "someone changed the chunk size and recall dropped 15%"
  *before* merge. Most teams don't do this and find out from customers.
- **Bundle-size budget.** The widget loads on every storefront page. Without a hard gate,
  it grows monotonically — someone adds a date library, someone adds an icon pack, and six
  months later it's 180 KB and the merchant is asking why their store got slower. A CI
  failure is the only thing that reliably prevents this.

---

## 11.4 Workflow files

Live in [`.github/workflows/`](../.github/workflows/):

| File | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PR, push to main | Quality gates — no AWS credentials needed for most jobs |
| `deploy-dev.yml` | push to main | Deploy to dev, smoke test |
| `deploy-prod.yml` | manual dispatch | Promote to prod with approval |

Job-level permissions matter:

```yaml
permissions:
  id-token: write     # required for OIDC
  contents: read      # least privilege — no write unless a job needs it
```

`id-token: write` is what lets the job request the OIDC token. Grant it only on jobs that
actually deploy — the lint job doesn't need AWS access and shouldn't be able to get it.

---

## 11.5 Quality gates in detail

### Architecture boundary

```yaml
- name: Enforce architecture boundaries
  run: |
    if grep -rE "@aws-sdk|@pinecone-database|aws-lambda" packages/core/src --include="*.ts"; then
      echo "::error::packages/core must not import infrastructure. See docs/07-backend.md"
      exit 1
    fi
```

Blunt, and it works. The ESLint rule from Phase 7.9 is the better version; keep both — the
grep catches it even if someone adds an eslint-disable.

### Retrieval eval

```yaml
- name: Retrieval eval
  run: npm run eval:retrieval -- --min-recall 0.90 --min-precision 0.75
```

Runs the golden set against the dev index. Exits non-zero on regression. This is the test
that makes prompt and chunking changes safe to ship.

### Bundle budget

```yaml
- name: Bundle size budget
  run: |
    npm run build --workspace=web/widget
    SIZE=$(gzip -c web/widget/dist/nailzify-widget.js | wc -c)
    echo "Bundle: ${SIZE} bytes gzipped"
    if [ "$SIZE" -gt 25600 ]; then
      echo "::error::Bundle ${SIZE}B exceeds 25KB budget"
      exit 1
    fi
```

### cdk-nag

```ts
// infra/bin/app.ts
import { AwsSolutionsChecks } from "cdk-nag";
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

Static analysis over the synthesized CloudFormation. Catches unencrypted buckets, wildcard
IAM, missing log retention, public access. Suppress individual rules **with a written
justification** — the suppression becomes documentation of a deliberate decision rather
than an oversight.

### Secret scanning

`gitleaks` in CI plus GitHub's push protection. Belt and braces. The cost of a leaked
Shopify token is measured in incident hours; the cost of this check is fifteen seconds.

---

## 11.6 What CI does *not* do

Deliberate exclusions:

- **Does not set secret values.** Secrets are populated once, out of band. A CI job that
  writes secrets is a CI job that can log them.
- **Does not run full generation evals on every PR.** They cost tokens and take minutes.
  Nightly and pre-deploy is the right cadence.
- **Does not auto-deploy to prod.** A human approves. For a customer-facing bot talking to
  real shoppers, the friction is correct. Automate *later*, once the eval suite has earned
  your trust.
- **Does not run ingestion.** Document ingestion is data, not code, and is triggered by S3
  uploads.

---

## 11.7 Branching

```
main          ← always deployable; protected; requires PR + green CI
  └─ feat/*   ← short-lived branches
  └─ fix/*
```

Trunk-based with short branches. No `develop`, no release branches, no gitflow. For a
single-maintainer project, gitflow's ceremony buys nothing and costs merge pain.

Branch protection on `main`: require PR, require status checks, no force push, no direct
commits.

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`) so release notes generate
themselves.

---

## 11.8 What FAANG does differently

Worth knowing the direction of travel, even where it's over-engineering for you today:

- **Continuous deployment to production**, with automated rollback on metric regression.
  The confidence comes from eval coverage, canary analysis, and feature flags — not from
  manual review. Manual approval is a *substitute* for that infrastructure; it's the right
  call now and the thing you eventually replace.
- **Feature flags for prompt versions**, so a prompt change ramps 1% → 10% → 100% with
  automated quality comparison at each step. Prompts get treated exactly like code.
- **Shadow traffic.** New retrieval configs run against real production queries in parallel
  with the live path, results compared offline, no customer impact. This is how you
  de-risk a chunking change on a system with real users.
- **Automated eval generation.** Production failures become eval cases automatically, so
  the regression suite grows without anyone curating it.
- **Hermetic, reproducible builds** with pinned toolchains and content-addressed artifacts.

Two of these are cheap enough to adopt now: **prompt versioning with metric correlation**
(you already log `promptVersion` — Phase 10.2) and **turning thumbs-down into eval cases**.
Both are afternoon-sized and compound over months.

---

Next: [Phase 12 — Roadmap](12-roadmap.md)
