import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * ⚠️ REACT SOURCE, PREACT RUNTIME.
 *
 * The bundle budget in CI is 25 KB gzipped, enforced on every PR. React plus
 * ReactDOM is ~45 KB gzipped before a single line of our own code — it cannot
 * fit, and raising the budget is not free: this script loads on EVERY storefront
 * page, including the ones where nobody opens the chat. A slower store is a real
 * cost paid by every visitor to buy a feature used by a few.
 *
 * Preact is ~4 KB and `preact/compat` implements the React API surface, so the
 * source here is ordinary React — hooks, JSX, function components — and the
 * alias swaps the runtime at build time. If this ever needs real React, the
 * change is deleting these two alias lines and raising the budget deliberately.
 */
export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
  build: {
    lib: {
      entry: "src/index.tsx",
      formats: ["iife"],
      name: "NailzifyWidget",
      fileName: () => "nailzify-widget.js",
    },
    // One self-contained file. A Shopify theme has no module graph we can rely
    // on, and code-splitting would mean extra round trips on someone else's page.
    rollupOptions: { output: { inlineDynamicImports: true } },
    cssCodeSplit: false,
    target: "es2020",
    minify: "esbuild",
    sourcemap: true,
  },
});
