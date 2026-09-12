import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// No dotenv discovery: the caller supplies an explicitly approved, empty,
// full-schema database. The suite checks exact host/port/name/principal.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: [
      "tests/weletic/shopify-company-store-bootstrap-db.integration.test.ts",
    ],
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    setupFiles: ["./tests/setupTests.ts"],
  },
});
