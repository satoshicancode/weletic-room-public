import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/weletic/shopify-billing-db.integration.test.ts"],
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    setupFiles: ["./tests/setupTests.ts"],
  },
});
