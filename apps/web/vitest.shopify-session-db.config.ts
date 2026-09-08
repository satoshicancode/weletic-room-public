import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Deliberately separate from legacy loyalty DB tests and their target guards.
// No dotenv discovery: the isolated runner supplies the sole database authority.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: [
      "tests/weletic/shopify-session-coordination-db.integration.test.ts",
      "tests/weletic/shopify-session-boundary-db.integration.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
