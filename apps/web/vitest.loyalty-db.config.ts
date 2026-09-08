import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: [
      "tests/weletic/loyalty-ledger-db.integration.test.ts",
      "tests/weletic/loyalty-operations-db.integration.test.ts",
      "tests/weletic/native-reviews-db.integration.test.ts",
    ],
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    setupFiles: ["./tests/setupTests.ts"],
  },
});
