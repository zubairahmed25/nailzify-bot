#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DIST="$PROJECT_ROOT/web/admin/dist"
ADMIN_ASSETS="$ADMIN_DIST/assets"
ADMIN_INDEX="$ADMIN_DIST/index.html"

AWS_PROFILE_NAME="${NAILZIFY_AWS_PROFILE:-zubair-browser}"
AWS_REGION_NAME="${NAILZIFY_AWS_REGION:-us-east-1}"
ADMIN_BUCKET="${NAILZIFY_ADMIN_BUCKET:-nailzify-dev-widget-984844735070}"
CLOUDFRONT_DOMAIN="${NAILZIFY_CLOUDFRONT_DOMAIN:-d183repo6i6gjz.cloudfront.net}"
SHOPIFY_API_KEY="${VITE_SHOPIFY_API_KEY:-8c1a30f0e9846049c1a201038130bf9a}"
INDEX_CACHE_CONTROL="no-cache, max-age=0, must-revalidate"
FORCE_INVALIDATION=false

if [[ "${1:-}" == "--invalidate" ]]; then
  FORCE_INVALIDATION=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: npm run deploy:admin -- [--invalidate]" >&2
  exit 2
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required. Install it, then run this command again." >&2
  exit 1
fi

echo "Checking AWS access..."
aws sts get-caller-identity \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_REGION_NAME" \
  --output json >/dev/null

previous_cache_control="$({
  aws s3api head-object \
    --bucket "$ADMIN_BUCKET" \
    --key "admin/index.html" \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION_NAME" \
    --query "CacheControl" \
    --output text
} 2>/dev/null || true)"

echo "Building the Shopify admin interface..."
cd "$PROJECT_ROOT"
VITE_SHOPIFY_API_KEY="$SHOPIFY_API_KEY" npm run build --workspace=web/admin

if [[ ! -d "$ADMIN_ASSETS" || ! -f "$ADMIN_INDEX" ]]; then
  echo "The admin build did not create the expected dist files." >&2
  exit 1
fi

echo "Uploading versioned assets..."
aws s3 cp "$ADMIN_ASSETS/" "s3://$ADMIN_BUCKET/admin/assets/" \
  --recursive \
  --cache-control "public, max-age=31536000, immutable" \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_REGION_NAME" \
  --only-show-errors

echo "Publishing the admin page..."
aws s3 cp "$ADMIN_INDEX" "s3://$ADMIN_BUCKET/admin/index.html" \
  --cache-control "$INDEX_CACHE_CONTROL" \
  --content-type "text/html; charset=utf-8" \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_REGION_NAME" \
  --only-show-errors

if [[ "$FORCE_INVALIDATION" == true || "$previous_cache_control" != "$INDEX_CACHE_CONTROL" ]]; then
  echo "Refreshing the existing CloudFront page cache..."
  distribution_id="$(aws cloudfront list-distributions \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION_NAME" \
    --query "DistributionList.Items[?DomainName=='$CLOUDFRONT_DOMAIN'].Id | [0]" \
    --output text)"

  if [[ -z "$distribution_id" || "$distribution_id" == "None" ]]; then
    echo "Could not find the CloudFront distribution for $CLOUDFRONT_DOMAIN." >&2
    exit 1
  fi

  aws cloudfront create-invalidation \
    --distribution-id "$distribution_id" \
    --paths "/admin/index.html" \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION_NAME" \
    --output json >/dev/null
else
  echo "CloudFront will revalidate index.html automatically."
fi

echo "Admin deployment complete: https://$CLOUDFRONT_DOMAIN/admin/index.html"
