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

// Marks this file a module. Without it TypeScript treats every script as one
// shared global scope, so top-level `const token` in two scripts collide — and
// top-level `await` is rejected.
export {};

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

/**
 * Describe the token shape — as a HINT ONLY, never as a verdict.
 *
 * ⚠️ Prefixes do NOT reliably identify a credential's purpose. `shpat_` covers
 * both Admin API tokens AND delegate access tokens, and a delegate token is
 * exactly what a private Storefront token is. Treating `shpat_` as "definitely
 * an Admin token" is wrong and, worse, previously blocked a perfectly valid
 * setup from running.
 *
 * The API is the only authority on whether a token works. Probe, don't infer.
 */
function describeShape(t: string): string {
  if (t.startsWith("shpat_")) {
    return "shpat_ — an Admin API token OR a delegate (private Storefront) token; both share this prefix";
  }
  if (t.startsWith("shpss_")) return "shpss_ — usually an app secret";
  if (t.startsWith("shpca_")) return "shpca_ — usually a client credential";
  if (/^[0-9a-f]{32}$/i.test(t)) return "32 hex — usually a PUBLIC Storefront token";
  return "unrecognised shape (this says nothing about validity)";
}

// ---------------------------------------------------------------------------
// Probe every header + API version combination.
// ---------------------------------------------------------------------------

const HEADERS = [
  { kind: "private", header: "Shopify-Storefront-Private-Token" },
  { kind: "public", header: "X-Shopify-Storefront-Access-Token" },
] as const;

/**
 * Candidate API versions, derived from TODAY rather than hardcoded.
 *
 * ⚠️ THIS IS THE BUG THAT COST US. Shopify releases quarterly (Jan/Apr/Jul/Oct)
 * and supports each version for roughly 12 months. A hardcoded list silently
 * rots: every entry retires, and a request against a retired version fails in a
 * way that looks like a bad token or a bad domain.
 *
 * Generating the list from the current date means this script keeps working
 * without anyone remembering to update it — and it reports the NEWEST version
 * that actually responds, so the answer is measured rather than assumed.
 */
function candidateVersions(now = new Date()): string[] {
  const out: string[] = [];
  // Quarter that has definitely shipped, then walk backwards two years.
  let year = now.getUTCFullYear();
  let month = [1, 4, 7, 10].filter((m) => m <= now.getUTCMonth() + 1).pop() ?? 10;
  if (month === 10 && now.getUTCMonth() + 1 < 10) year -= 1;

  for (let i = 0; i < 9; i += 1) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 3;
    if (month < 1) {
      month = 10;
      year -= 1;
    }
  }
  return out;
}

const VERSIONS = candidateVersions();

console.log("TOKEN SHAPE (informational — the probe below is what decides)");
console.log(`  masked            ${mask(token)}`);
console.log(`  length            ${token.length}`);
console.log(`  prefix hint       ${describeShape(token)}`);
console.log(`  shop              ${shopDomain}`);
console.log(`  probing versions  ${VERSIONS.join(", ")}\n`);

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
      // Shopify usually explains a 4xx in the body. Capture enough of it to be
      // useful — the status code alone does not distinguish the causes.
      let detail = text.slice(0, 300).replace(/\s+/g, " ").trim() || "(empty body)";
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
      "\n  ⚠️ This is a PUBLIC token — which is exactly what a custom app's API\n" +
        "     credentials page issues, so this is the expected result for that setup.\n\n" +
        "     Fine for development. Before production, move to a PRIVATE token:\n" +
        "     public tokens meter by CUSTOMER IP, but every production call comes\n" +
        "     from a handful of Lambda IPs, so all shoppers would share one\n" +
        "     rate-limit bucket and throttle under modest load.\n\n" +
        "     Private tokens are NOT on the custom-app page. Obtain one by adding\n" +
        "     the Headless channel to the store, or via a delegate access token.",
    );
  }
  console.log("    npx vite-node scripts/verify-shopify.ts");
  process.exit(0);
}

// Nothing worked — narrow it down from the failure pattern.
const all401 = results.every((r) => r.status === 401);
const all403 = results.every((r) => r.status === 403);
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
} else if (all403) {
  console.log(
    "  Every request returned 403. That is meaningfully different from 401:\n" +
      "  the token was ACCEPTED but the request was not AUTHORIZED. So the token\n" +
      "  itself is real and belongs to this store — the problem is permission or\n" +
      "  storefront visibility.\n\n" +
      "  Causes, in order of likelihood:\n\n" +
      "  1. The app lacks unauthenticated_read_product_listings.\n" +
      "     Develop apps -> your app -> Configuration ->\n" +
      "       Storefront API integration -> Configure ->\n" +
      "       tick unauthenticated_read_product_listings -> Save\n" +
      "     ⚠️ Then REINSTALL the app and copy the NEW token. Scopes are baked in\n" +
      "        when a token is issued; an existing token does not gain them.\n\n" +
      "  2. The storefront is PASSWORD PROTECTED.\n" +
      "     Online Store -> Preferences -> Password protection.\n" +
      "     A protected storefront restricts unauthenticated Storefront API\n" +
      "     access. Development stores have this on by default, which is why this\n" +
      "     bites so often. Disable it, or test against a store without it.\n\n" +
      "  3. No products are published to the sales channel this token can see.\n" +
      "     A product must be published to the relevant channel to be readable.\n" +
      "     Check a product -> Publishing -> ensure the channel is ticked.\n\n" +
      "  Read the response body in the table above — Shopify usually names the\n" +
      "  missing scope explicitly.",
  );
} else if (all401) {
  console.log(
    "  Both headers and all API versions returned 401, so this is NOT a header\n" +
      "  mismatch and NOT an API-version problem. Remaining causes, in order:\n\n" +
      "  1. Storefront API integration was never configured for the app.\n" +
      "     A custom app has Admin API scopes and Storefront API scopes as\n" +
      "     SEPARATE sections. Installing the app is not enough — the Storefront\n" +
      "     section must be configured explicitly.\n" +
      "     Note that page issues a PUBLIC token. Private tokens come from the\n" +
      "     Headless channel or a delegate token, so don't hunt for one there.\n\n" +
      "  2. The token predates the scope. Scopes are baked in at issue time, so\n" +
      "     you must reinstall and copy the NEW token.\n\n" +
      "  3. The token belongs to a different store than this shop domain.\n\n" +
      "  4. The app was uninstalled, which revokes its tokens.",
  );
} else {
  console.log("  Mixed failures — see the table above for the specific responses.");
}

process.exit(1);
