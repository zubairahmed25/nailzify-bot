# Nailzify admin page

The embedded page merchants see inside Shopify Admin: upload a policy/FAQ/guide PDF,
watch it get indexed. React source, Preact runtime — see "Why Preact" below for why
that choice doesn't mean the same thing here as it does for the storefront widget.

```bash
npm run dev   --workspace=web/admin   # local, App Bridge unavailable outside Shopify
npm run build --workspace=web/admin   # -> dist/index.html + dist/assets/*
```

## Why Preact, when there's no bundle budget this time

`web/widget` uses Preact because its script loads on every storefront page view and
React + ReactDOM (~45 KB gzipped) doesn't fit a 25 KB budget. Nothing here loads on a
storefront — this page loads once, when a merchant opens the app. The choice is
Preact anyway, purely to reuse an already-configured, proven toolchain (same
`vite.config.ts` shape, same `tsconfig.json`) rather than stand up a second one for a
single small page. If this page ever needs something Preact can't do, switching to
real React is deleting the two alias lines in `vite.config.ts`.

## Auth: session tokens, not the App Proxy

The storefront widget and this page hit the same CloudFront distribution but
authenticate completely differently. The widget's request is signed by Shopify
itself (App Proxy HMAC) before it ever reaches a browser. This page runs *inside* the
Shopify admin iframe, and Shopify's App Bridge — loaded via the CDN script tag in
`index.html`, not an npm package — mints a short-lived JWT (`window.shopify.idToken()`)
that `src/api.ts` attaches as `Authorization: Bearer <token>` on every request to
`/admin/api/*`. `services/admin/src/security/verify-session-token.ts` verifies it on
the way in.

## Uploads go straight to S3

`POST /admin/api/uploads` doesn't receive the file — it returns a presigned S3 PUT
URL. The browser PUTs the PDF directly to S3 (`src/api.ts`'s `putFile`), which fires
the same EventBridge rule and ingestion Lambda every other document upload already
goes through (`infra/lib/ingestion-stack.ts`). Nothing here ever holds the PDF's bytes
in memory.

## Deploying

Built assets are content-hashed (`dist/assets/index-XXXX.js`) except `index.html`
itself, which is not — this matters because unlike the widget (delivered through
Shopify's own versioned theme CDN), this page is served through OUR CloudFront
distribution's `CACHING_OPTIMIZED` default behavior (`infra/lib/api-stack.ts`), which
caches aggressively. An `index.html` deployed without care can keep pointing at
asset hashes from a PREVIOUS build that no longer exist in the bucket.

```bash
aws s3 cp dist/assets/ "s3://<WidgetBucketName>/admin/assets/" --recursive \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp dist/index.html "s3://<WidgetBucketName>/admin/index.html" \
  --cache-control "no-cache"
```

Assets first, `index.html` last — so a request landing between the two commands still
resolves to either the old, fully-present build or the new one, never a half-updated
mix. `no-cache` on `index.html` means CloudFront always revalidates it; the immutable
Cache-Control on hashed assets is what makes that revalidation cheap instead of a full
re-fetch. `<WidgetBucketName>` is the `WidgetBucketName` CDK output from the Api stack
— the same bucket the widget itself doesn't use (it ships through Shopify's theme
assets instead), repurposed here under a distinct `admin/` prefix.

`VITE_SHOPIFY_API_KEY` must be set at build time — it's baked into `index.html`'s
`shopify-api-key` meta tag via Vite's HTML env replacement, not read at runtime. Use
the same value as the CDK `shopifyApiKey` context (`infra/bin/app.ts`), which
`services/admin`'s Lambda validates every session token's `aud` claim against:

```bash
VITE_SHOPIFY_API_KEY=<client id> npm run build --workspace=web/admin
```

The app's "Application URL" in the Partner Dashboard (Step 5 — not done yet) should
point at `https://<distribution-domain>/admin/index.html`.
