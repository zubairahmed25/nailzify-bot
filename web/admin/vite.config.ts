import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * Ordinary Vite app build, unlike the storefront widget's single-file `lib`
 * build. The widget is a script injected into a theme nobody controls but us,
 * so it has to be one dependency-free file; this is a real page — the thing
 * Shopify iframes when a merchant opens the app — so a normal `index.html` +
 * hashed asset build is the right shape, and Preact is used here purely to
 * reuse a proven, already-configured toolchain, not because of a bundle
 * budget the way it is for the widget (docs in web/widget/README.md).
 *
 * `base: "/admin/"` matters at build time, not just deploy time: it is baked
 * into every asset URL `index.html` references. The build output is uploaded
 * under the `admin/` prefix of the SAME bucket the widget already uses
 * (infra/lib/api-stack.ts's `WidgetBucket`, served by the CloudFront
 * distribution's default behavior) — get this wrong and the page loads but
 * every JS/CSS request 404s, because the URLs point at the bucket root
 * instead of `admin/`.
 */
export default defineConfig({
  base: "/admin/",
  plugins: [preact()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
  build: {
    target: "es2020",
    sourcemap: true,
  },
});
