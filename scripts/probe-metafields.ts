/**
 * Inspect product metafields on the Storefront API.
 *
 *     export SHOPIFY_SHOP_DOMAIN=nailzify.myshopify.com
 *     export SHOPIFY_STOREFRONT_TOKEN=...
 *     export SHOPIFY_API_VERSION=2025-10
 *     npx vite-node scripts/probe-metafields.ts
 *
 * WHY THIS EXISTS. Attributes live in metafields, not tags. But metafield VALUES
 * are not uniformly strings: `shopify.*` namespace fields are taxonomy-backed and
 * commonly store metaobject references, so `value` is a JSON array of GIDs rather
 * than "matte". A parser written against an assumed shape would silently produce
 * garbage attributes — the same class of bug as defaulting an untagged product to
 * "almond".
 *
 * So this prints the raw `type` and `value` for each field, plus any resolved
 * reference names, and the distinct values across the catalogue. That last part
 * is what tells us which enum members the domain actually needs.
 *
 * ⚠️ Storefront metafield access requires token permission. If every field comes
 * back null while products load fine, that is the cause — not a wrong namespace.
 */

// Marks this file a module. Without it TypeScript treats every script as one
// shared global scope, so top-level `const token` in two scripts collide — and
// top-level `await` is rejected.
export {};

const shopDomain = process.env["SHOPIFY_SHOP_DOMAIN"];
const token = process.env["SHOPIFY_STOREFRONT_TOKEN"];
const apiVersion = process.env["SHOPIFY_API_VERSION"] ?? "2025-10";
const tokenKind = process.env["SHOPIFY_TOKEN_KIND"] === "public" ? "public" : "private";

if (!shopDomain || !token) {
  console.error(
    "Set both:\n" +
      "  export SHOPIFY_SHOP_DOMAIN=nailzify.myshopify.com\n" +
      "  export SHOPIFY_STOREFRONT_TOKEN=<token>",
  );
  process.exit(1);
}

/** The identifiers as configured on the store. */
const IDENTIFIERS = [
  { namespace: "custom", key: "nail_text", role: "shape" },
  { namespace: "custom", key: "nail_type", role: "type" },
  { namespace: "shopify", key: "color-pattern", role: "colour" },
  { namespace: "shopify", key: "finish", role: "finish" },
];

const QUERY = `
  query ProbeMetafields($ids: [HasMetafieldsIdentifier!]!) {
    products(first: 40) {
      nodes {
        handle
        title
        metafields(identifiers: $ids) {
          namespace
          key
          type
          value
          reference { ... on Metaobject { handle type field(key: "label") { value } } }
          references(first: 10) {
            nodes { ... on Metaobject { handle type field(key: "label") { value } } }
          }
        }
      }
    }
  }
`;

interface MetaobjectRef {
  readonly handle?: string;
  readonly type?: string;
  readonly field?: { readonly value?: string } | null;
}

interface Metafield {
  readonly namespace: string;
  readonly key: string;
  readonly type: string;
  readonly value: string;
  readonly reference?: MetaobjectRef | null;
  readonly references?: { readonly nodes?: MetaobjectRef[] } | null;
}

interface ProductNode {
  readonly handle: string;
  readonly title: string;
  readonly metafields: (Metafield | null)[];
}

const response = await fetch(`https://${shopDomain}/api/${apiVersion}/graphql.json`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(tokenKind === "public"
      ? { "X-Shopify-Storefront-Access-Token": token }
      : { "Shopify-Storefront-Private-Token": token }),
  },
  body: JSON.stringify({
    query: QUERY,
    variables: { ids: IDENTIFIERS.map(({ namespace, key }) => ({ namespace, key })) },
  }),
});

const body = (await response.json()) as {
  data?: { products?: { nodes?: ProductNode[] } };
  errors?: { message: string }[];
};

if (body.errors?.length) {
  console.error("GraphQL errors:");
  for (const e of body.errors) console.error(`  ${e.message}`);
  console.error(
    "\nIf these mention metafield access, the token lacks metafield permission.\n" +
      "Storefront metafields require it explicitly, separately from product listings.",
  );
  process.exit(1);
}

const products = body.data?.products?.nodes ?? [];
console.log(`SHOP ${shopDomain}   API ${apiVersion}   ${products.length} products\n`);

/** Best human-readable value we can get out of a metafield. */
function readable(mf: Metafield): string {
  const refs = mf.references?.nodes ?? [];
  if (refs.length > 0) {
    return refs.map((r) => r.field?.value ?? r.handle ?? "?").join(", ");
  }
  if (mf.reference) return mf.reference.field?.value ?? mf.reference.handle ?? "?";
  return mf.value;
}

// ---- 1. Raw shape of the first product that actually has values -------------

const sample = products.find((p) => p.metafields.some((m) => m !== null));

console.log("1. RAW SHAPE (first product with any metafield set)");
if (!sample) {
  console.log("  none of the 40 products returned a single metafield value.\n");
  console.log("  Either the token lacks metafield access, or the namespace/key pairs differ.");
  process.exit(1);
}
console.log(`  product: ${sample.title} (${sample.handle})\n`);
for (const [i, mf] of sample.metafields.entries()) {
  const role = IDENTIFIERS[i]!.role;
  if (!mf) {
    console.log(`  ${role.padEnd(8)} (null — not set on this product)`);
    continue;
  }
  console.log(`  ${role.padEnd(8)} ${mf.namespace}.${mf.key}`);
  console.log(`  ${" ".repeat(8)}   type     ${mf.type}`);
  console.log(`  ${" ".repeat(8)}   value    ${mf.value.slice(0, 160)}`);
  console.log(`  ${" ".repeat(8)}   readable ${readable(mf)}`);
}

// ---- 2. Coverage + distinct values across the catalogue --------------------

console.log("\n2. COVERAGE AND DISTINCT VALUES");
for (const [i, { role, namespace, key }] of IDENTIFIERS.entries()) {
  const present = products.filter((p) => p.metafields[i] != null);
  const values = new Map<string, number>();
  for (const p of present) {
    for (const v of readable(p.metafields[i]!).split(", ")) {
      values.set(v, (values.get(v) ?? 0) + 1);
    }
  }

  console.log(`\n  ${role.toUpperCase()}  (${namespace}.${key})`);
  console.log(`    set on          ${present.length}/${products.length} products`);
  console.log(`    type            ${present[0]?.metafields[i]?.type ?? "—"}`);
  const sorted = [...values.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`    distinct values ${sorted.length}`);
  for (const [value, count] of sorted.slice(0, 15)) {
    console.log(`      ${String(count).padStart(3)}x  ${value}`);
  }
  if (sorted.length > 15) console.log(`      ... and ${sorted.length - 15} more`);
}

console.log(
  "\nPaste this output back — the distinct values determine which enum members\n" +
    "the domain needs, and the `type` determines how the adapter must parse each one.",
);
