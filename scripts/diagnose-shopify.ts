/**
 * Shopify Storefront auth diagnostic.
 *
 *     export SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
 *     export SHOPIFY_STOREFRONT_TOKEN=...
 *     npx vite-node scripts/diagnose-shopify.ts
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-shopify.ts. A 401 from Shopify carries
 * no explanation, and there are at least five distinct causes that all present
 * identically. Rather than have you try them one at a time, this probes each
 * combination and reports what the API actually said.
 *
 * It NEVER prints the token — only its length and a masked prefix.
 */

const shopDomain = process.env["SHOPIFY_SHOP_DOMAIN"];
const token = process.env["SHOPIFY_STOREFRONT_TOKEN"];

if (!shopDomain || !token) {
  console.error(
    "Set both:\n" +
      "  export SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com\n" +
      "  export SHOPIFY_STOREFRONT_TOKEN=<token>",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------

const mask = (t: string) =>
  t.length <= 8 ? "*".repeat(t.length) : `${t.slice(0, 4)}${"*".repeat(t.length - 8)}${t.slice(-4)}`;

console.log("TOKEN SHAPE");
console.log(`  masked            ${mask(token)}`);
console.log(`  length            ${token.length}`);
console.log(`  looks like        ${describeShape(token)}`);
console.log(`  shop              ${shopDomain}\n`);

function describeShape(t: string): string {
  if (t.startsWith("shpat_")) return "ADMIN API token (shpat_) — wrong credential entirely";
  if (t.startsWith("shpss_")) return "app secret / client secret — wrong credential entirely";
  if (t.startsWith("shpca_")) return "client credential — wrong credential entirely";
  if (/^[0-9a-f]{32}$/i.test(t)) return "PUBLIC Storefront token (32 hex)";
  if (/^shpsa_/.test(t)) return "private Storefront token";
  return "unrecognised — could still be a valid private token";
}

// ---------------------------------------------------------------------------
// Probe every header + API version combination.
// ---------------------------------------------------------------------------

const HEADERS = [
  { kind: "private", header: "Shopify-Storefront-Private-Token" },
  { kind: "public", header: "X-Shopify-Storefront-Access-Token" },
] as const;

// If the pinned version is retired the API 404s, which reads like a bad domain.
const VERSIONS = ["2025-01", "2025-04", "2024-10"];

// Cheapest possible query that still proves the product scope is granted.
const QUERY = `{ shop { name } products(first: 1) { nodes { handle } } }`;

interface Probe {
  readonly kind: string;
  readonly version: string;
  readonly status: number;
  readonly detail: string;
  readonly ok: boolean;
}

const results: Probe[] = [];

for (const version of VERSIONS) {
  for (const { kind, header } of HEADERS) {
    const url = `https://${shopDomain}/api/${version}/graphql.json`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [header]: token },
        body: JSON.stringify({ query: QUERY }),
        signal: AbortSignal.timeout(10_000),
      });

      const text = await response.text();
      let detail = text.slice(0, 160).replace(/\s+/g, " ");
      let ok = false;

      if (response.ok) {
        try {
          const body = JSON.parse(text) as {
            data?: { shop?: { name?: string }; products?: { nodes?: unknown[] } };
            errors?: { message?: string }[];
          };
          if (body.errors?.length) {
            detail = `GraphQL: ${body.errors.map((e) => e.message).join("; ").slice(0, 120)}`;
          } else if (body.data?.shop?.name) {
            ok = true;
            detail = `shop "${body.data.shop.name}", ${body.data.products?.nodes?.length ?? 0} product(s) readable`;
          }
        } catch {
          detail = "200 but body was not JSON";
        }
      }

      results.push({ kind, version, status: response.status, detail, ok });
    } catch (error) {
      results.push({
        kind,
        version,
        status: 0,
        detail: `network: ${(error as Error).message.slice(0, 100)}`,
        ok: false,
      });
    }
  }
}

console.log("PROBE RESULTS");
for (const r of results) {
  const mark = r.ok ? "✅" : "  ";
  console.log(`  ${mark} ${r.kind.padEnd(8)} ${r.version.padEnd(9)} HTTP ${String(r.status).padEnd(4)} ${r.detail}`);
}

// ---------------------------------------------------------------------------

const working = results.find((r) => r.ok);

console.log("\nVERDICT");

if (working) {
  console.log(`  ✅ WORKS: token kind "${working.kind}", API version ${working.version}\n`);
  console.log("  Run the full verification with:");
  console.log(`    export SHOPIFY_API_VERSION=${working.version}`);
  if (working.kind === "public") {
    console.log("    export SHOPIFY_TOKEN_KIND=public");
    console.log(
      "\n  ⚠️ This is a PUBLIC token. It works, but it meters by CUSTOMER IP —\n" +
        "     and every call from production originates from a few Lambda IPs, so\n" +
        "     all shoppers would share one rate-limit bucket. Switch to a private\n" +
        "     token before going live.",
    );
  }
  console.log("    npx vite-node scripts/verify-shopify.ts");
  process.exit(0);
}

// Nothing worked — narrow it down from the failure pattern.
const all401 = results.every((r) => r.status === 401);
const all404 = results.every((r) => r.status === 404);
const anyGraphQlScope = results.some((r) => /access denied|scope|permission/i.test(r.detail));

if (anyGraphQlScope) {
  console.log(
    "  The token AUTHENTICATES but lacks the product scope.\n\n" +
      "  Shopify admin -> Settings -> Apps and sales channels -> Develop apps\n" +
      "    -> your app -> Configuration -> Storefront API integration -> Configure\n" +
      "    -> tick unauthenticated_read_product_listings -> Save\n" +
      "  Then reinstall the app and copy the NEW token.",
  );
} else if (all404) {
  console.log(
    `  Every request 404'd, which points at the SHOP DOMAIN rather than the token.\n\n` +
      `  SHOPIFY_SHOP_DOMAIN is "${shopDomain}". It must be the permanent\n` +
      "  .myshopify.com host — not a custom storefront domain. Find it in\n" +
      "  Shopify admin -> Settings -> Domains (look for the myshopify.com one).",
  );
} else if (all401) {
  console.log(
    "  Both headers and all API versions returned 401, so this is NOT a header\n" +
      "  mismatch and NOT an API-version problem. Remaining causes, in order:\n\n" +
      "  1. Storefront API integration was never configured for the app.\n" +
      "     A custom app has Admin API scopes and Storefront API scopes as\n" +
      "     SEPARATE sections. Having installed the app is not enough — the\n" +
      "     Storefront section must be configured explicitly.\n\n" +
      "  2. The token predates the scope. Scopes are baked in at issue time, so\n" +
      "     you must reinstall and copy the NEW token.\n\n" +
      "  3. The token belongs to a different store than this shop domain.\n\n" +
      "  4. The app was uninstalled, which revokes its tokens.",
  );
} else {
  console.log("  Mixed failures — see the table above for the specific responses.");
}

process.exit(1);
