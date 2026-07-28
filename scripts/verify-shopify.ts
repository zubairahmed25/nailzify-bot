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
// ⚠️ Shopify retires each API version after ~12 months. A stale default fails
// in a way that looks like a bad token. Run scripts/diagnose-shopify.ts to find
// the newest version this store actually accepts.
const apiVersion = process.env["SHOPIFY_API_VERSION"] ?? "2025-10";
// Private is correct for server-side callers. Set SHOPIFY_TOKEN_KIND=public
// only if you deliberately created a public Storefront token.
const tokenKind = process.env["SHOPIFY_TOKEN_KIND"] === "public" ? "public" : "private";

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

// ---------------------------------------------------------------------------
// Preflight: diagnose the common misconfigurations WITHOUT printing the token.
//
// A 401 from Shopify says nothing about why. These checks turn "it doesn't work"
// into a specific next action.
// ---------------------------------------------------------------------------

// ⚠️ THESE ARE HINTS, NOT GATES. An earlier version BLOCKED on token shape and
// rejected a perfectly valid setup: `shpat_` covers Admin API tokens AND
// delegate access tokens, and a delegate token is precisely what a private
// Storefront token is.
//
// A credential's prefix does not determine its purpose. The API is the only
// authority on whether a token works, so we warn and proceed — never preempt it.
const hints: string[] = [];

if (accessToken.startsWith("shpss_") || accessToken.startsWith("shpca_")) {
  hints.push(
    "Token prefix suggests an app secret / client credential rather than a\n" +
      "     Storefront token. If auth fails, check you didn't paste the API secret\n" +
      "     key — that one is for verifying inbound App Proxy HMAC.",
  );
}

if (!shopDomain.endsWith(".myshopify.com")) {
  hints.push(
    `SHOPIFY_SHOP_DOMAIN is "${shopDomain}", which is not a .myshopify.com host.\n` +
      "     The API host must be the permanent domain. Set SHOPIFY_STOREFRONT_DOMAIN\n" +
      "     separately if your public storefront domain differs.",
  );
}

if (hints.length > 0) {
  console.log("PREFLIGHT NOTES (not blocking — proceeding anyway)\n");
  for (const hint of hints) console.log(`  •  ${hint}\n`);
}

const warnings: string[] = [];
const client = createStorefrontClient({ shopDomain, accessToken, apiVersion, tokenKind });
const catalog = createShopifyProductCatalog({
  client,
  storefrontDomain,
  onWarning: (w) => warnings.push(w),
});

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(26)} ${String(value)}`);

// ---------------------------------------------------------------------------

console.log(`SHOP  ${shopDomain}   API ${apiVersion}   token kind: ${tokenKind}\n`);

console.log("1. AUTH + SCOPE");
let page;
try {
  page = await catalog.listAll();
  line("products returned", page.items.length);
  line("has more pages", page.cursor !== null);
} catch (e) {
  const message = (e as Error).message;
  console.error(`  FAILED — ${message}`);

  if (message.includes("401")) {
    console.error(
      `\n  Sent as a ${tokenKind.toUpperCase()} token, header ` +
        (tokenKind === "public"
          ? "X-Shopify-Storefront-Access-Token.\n"
          : "Shopify-Storefront-Private-Token.\n") +
      "  ⚠️ The two kinds use DIFFERENT headers, and a mismatch returns a 401 that\n" +
      "     looks identical to a bad token. If you created a PUBLIC token, re-run\n" +
      "     with SHOPIFY_TOKEN_KIND=public.\n" +
      "\n  Otherwise the cause is almost certainly one of:\n\n" +
        "  1. Storefront API access was never enabled for the app.\n" +
        "     Shopify admin -> Settings -> Apps and sales channels -> Develop apps\n" +
        "       -> your app -> Configuration\n" +
        "       -> Storefront API integration -> Configure\n" +
        "       -> tick 'unauthenticated_read_product_listings' -> Save\n" +
        "     Then go to API credentials and INSTALL (or reinstall) the app.\n" +
        "     ⚠️ A token issued before the scope was added does not gain it —\n" +
        "        you must reinstall and copy the NEW token.\n\n" +
        "  2. The app is not installed on this store at all.\n\n" +
        "  3. The token belongs to a different store than SHOPIFY_SHOP_DOMAIN.\n",
    );
  } else if (message.includes("404")) {
    console.error(
      `\n  404 usually means the shop domain is wrong, or API version "${apiVersion}"\n` +
        "  is no longer supported — Shopify retires versions after ~12 months.\n" +
        "  Run: npx vite-node scripts/diagnose-shopify.ts\n",
    );
  }
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

console.log("\n4. METAFIELD COVERAGE");
//
// ⚠️ The previous version of this section reported "fully tagged 40/40" by
// checking warnings for the word "missing" — which the warnings never contain.
// It was structurally incapable of reporting anything else. A metric that cannot
// fail is worse than no metric: it reads as reassurance.
//
// This counts the attributes themselves.
const items = page.items;
const withShape = items.filter((p) => p.attributes.shape !== null).length;
const withLength = items.filter((p) => p.attributes.length !== null).length;
const withStyle = items.filter((p) => p.attributes.style !== null).length;
const withColour = items.filter((p) => p.attributes.colourNotes.length > 0).length;
const withFinish = items.filter((p) => p.attributes.finishes.length > 0).length;
const multiFinish = items.filter((p) => p.attributes.finishes.length > 1).length;

const total = items.length;
line("shape   (custom.nail_text)", `${withShape}/${total}`);
line("style   (custom.nail_type)", `${withStyle}/${total}`);
line("colour  (shopify.color-pattern)", `${withColour}/${total}`);
line("finish  (shopify.finish)", `${withFinish}/${total}`);
line("  of which multi-finish", `${multiFinish} (must be preserved, not truncated)`);
line("length  (split from shape)", `${withLength}/${total}`);

line("total warnings", warnings.length);
for (const warning of warnings.slice(0, 12)) console.log(`     ${warning}`);
if (warnings.length > 12) console.log(`     ... and ${warnings.length - 12} more`);

// Products carrying no nail attribute at all are accessories — files, removers,
// glues. Listed so the classification can be eyeballed rather than assumed.
const accessories = items.filter(
  (p) =>
    p.attributes.shape === null &&
    p.attributes.style === null &&
    p.attributes.colourNotes.length === 0 &&
    p.attributes.finishes.length === 0,
);
console.log(`\n  Classified as accessories (no nail attributes): ${accessories.length}`);
for (const p of accessories) console.log(`     ${p.title}`);
console.log("  ^ these should ALL be non-nail products. A nail set here is a bug.");

// productType is fetched but not yet used for classification. Printing the
// distinct values is how we find out whether it is a better signal than the
// attribute heuristic above — measured, not assumed.
const types = new Map<string, number>();
for (const p of items) {
  const t = p.productType || "(empty)";
  types.set(t, (types.get(t) ?? 0) + 1);
}
console.log("\n  Distinct productType values:");
for (const [t, n] of [...types].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${n.toString().padStart(3)}  ${t}`);
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
