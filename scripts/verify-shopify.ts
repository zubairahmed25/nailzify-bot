/**
 * Live Shopify catalog verification.
 *
 *     export SHOPIFY_SHOP_DOMAIN=nailzify.myshopify.com
 *     export SHOPIFY_STOREFRONT_TOKEN=...          # never commit this
 *     npx vite-node scripts/verify-shopify.ts
 *
 * WHY ENV VARS. The token is a secret. Reading it from the environment keeps it
 * out of the repo, out of shell history if you use a .env file, and out of any
 * transcript. Nothing here prints it.
 *
 * WHY THIS SCRIPT EXISTS. The Shopify adapter is tested against fixtures shaped
 * to the documented schema — good, but not the same as observation. On this
 * project live checks have contradicted documented or assumed shapes four times.
 * This is how the catalog adapter stops being provisional.
 *
 * WHAT IT CHECKS:
 *   1. auth + scope        does the token work, and can it read products
 *   2. field shapes        are the nullable fields actually null in practice
 *   3. money parsing       does the decimal string survive as exact minor units
 *   4. tag conventions     how many products carry the attribute tags we expect
 *   5. batch hydration     does nodes(ids:) return what we asked for
 *   6. deleted products    does a bogus id come back null rather than erroring
 */

import { createShopifyProductCatalog, createStorefrontClient } from "@nailzify/adapters";
import { ProductId, formatMoney, priceBandOf } from "@nailzify/core";

const shopDomain = process.env["SHOPIFY_SHOP_DOMAIN"];
const accessToken = process.env["SHOPIFY_STOREFRONT_TOKEN"];
// Public storefront domain for fallback URLs; defaults to the myshopify one.
const storefrontDomain = process.env["SHOPIFY_STOREFRONT_DOMAIN"] ?? shopDomain ?? "";
const apiVersion = process.env["SHOPIFY_API_VERSION"] ?? "2025-01";

if (!shopDomain || !accessToken) {
  console.error(
    "Missing configuration.\n\n" +
      "  export SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com\n" +
      "  export SHOPIFY_STOREFRONT_TOKEN=<Storefront API access token>\n\n" +
      "The token comes from your Shopify custom app:\n" +
      "  Shopify admin -> Settings -> Apps and sales channels -> Develop apps\n" +
      "  -> your app -> API credentials -> Storefront API access token\n" +
      "  (tokens only appear AFTER you click Install app)\n\n" +
      "Required scope: unauthenticated_read_product_listings\n\n" +
      "That page shows several credentials. You want the STOREFRONT API ACCESS\n" +
      "TOKEN — not the Admin API token, and not the API key / API secret key.\n" +
      "  Storefront API access token -> calling the Storefront API (this script)\n" +
      "  API secret key (Client secret) -> verifying App Proxy HMAC (used later)\n" +
      "  Admin API access token -> deliberately unused; see storefront-client.ts",
  );
  process.exit(1);
}

const warnings: string[] = [];
const client = createStorefrontClient({ shopDomain, accessToken, apiVersion });
const catalog = createShopifyProductCatalog({
  client,
  storefrontDomain,
  onWarning: (w) => warnings.push(w),
});

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(26)} ${String(value)}`);

// ---------------------------------------------------------------------------

console.log(`SHOP  ${shopDomain}   API ${apiVersion}\n`);

console.log("1. AUTH + SCOPE");
let page;
try {
  page = await catalog.listAll();
  line("products returned", page.items.length);
  line("has more pages", page.cursor !== null);
} catch (e) {
  console.error(`  FAILED — ${(e as Error).message}`);
  console.error(
    "\n  401/403 usually means a wrong token type (Admin instead of Storefront)\n" +
      "  or a missing unauthenticated_read_product_listings scope.",
  );
  process.exit(1);
}

if (page.items.length === 0) {
  console.error("\n  No products returned. Is the app installed and are products published\n" +
    "  to the sales channel the token is scoped to?");
  process.exit(1);
}

// ---------------------------------------------------------------------------

console.log("\n2. FIELD SHAPES (the nullable ones that bit us in review)");
const nullUrl = page.items.filter((p) => p.url.includes(`https://${storefrontDomain}/products/`)).length;
const nullImage = page.items.filter((p) => p.imageUrl === null).length;
const nullQty = page.items.filter((p) => p.variants.some((v) => v.quantityAvailable === null)).length;
line("using fallback URL", `${nullUrl}/${page.items.length} (onlineStoreUrl was null)`);
line("no featured image", `${nullImage}/${page.items.length}`);
line("null quantityAvailable", `${nullQty}/${page.items.length} (needs extra token scope)`);

// ---------------------------------------------------------------------------

console.log("\n3. MONEY PARSING");
for (const product of page.items.slice(0, 5)) {
  line(
    product.handle.slice(0, 24),
    `${formatMoney(product.price)}  minor=${product.price.amountMinor}  band=${priceBandOf(product.price)}  ${product.available ? "in stock" : "SOLD OUT"}`,
  );
}
const fractional = page.items.filter((p) => !Number.isInteger(p.price.amountMinor));
line("non-integer minor units", `${fractional.length} (must be 0)`);

// ---------------------------------------------------------------------------

console.log("\n4. MERCHANDISING TAGS");
// Every product missing an attribute tag is a product that silently stops
// matching those queries. This count is the real signal.
const tagged = page.items.filter(
  (p) => !warnings.some((w) => w.includes(`"${p.title}"`) && w.includes("missing")),
).length;
line("fully tagged", `${tagged}/${page.items.length}`);
line("total warnings", warnings.length);
for (const warning of warnings.slice(0, 12)) console.log(`     ${warning}`);
if (warnings.length > 12) console.log(`     ... and ${warnings.length - 12} more`);

if (tagged === 0) {
  console.log(
    "\n  No products carry attribute tags yet. Add namespaced tags in the Shopify\n" +
      "  admin so semantic filtering works, e.g.:\n" +
      "     shape:almond   length:short   finish:matte   occasion:bridal   level:beginner",
  );
}

// ---------------------------------------------------------------------------

console.log("\n5. BATCH HYDRATION");
const ids = page.items.slice(0, 3).map((p) => p.id);
const hydrated = await catalog.getByIds(ids);
line("requested / returned", `${ids.length} / ${hydrated.length}`);
line("order preserved", hydrated.map((p) => p.id).join(",") === ids.join(",") ? "yes" : "no");

console.log("\n6. DELETED PRODUCT HANDLING");
const withBogus = await catalog.getByIds([
  ids[0]!,
  ProductId("gid://shopify/Product/999999999999"),
]);
line("bogus id dropped", withBogus.length === 1 ? "yes — returns null, not an error" : `NO (got ${withBogus.length})`);

// ---------------------------------------------------------------------------

console.log("\n7. SINGLE PRODUCT BY HANDLE");
const first = page.items[0]!;
const byHandle = await catalog.getByHandle(first.handle);
line("round-trips", byHandle?.id === first.id ? "yes" : "NO");
line("title", byHandle?.title ?? "?");
line("attributes", JSON.stringify(byHandle?.attributes ?? {}));

console.log("\nDONE — the catalog adapter is now live-verified against this store.");
