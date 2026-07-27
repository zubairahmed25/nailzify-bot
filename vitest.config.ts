import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@nailzify/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "cdk.out/**"],
    coverage: {
      include: ["packages/core/src/**"],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
