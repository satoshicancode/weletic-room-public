import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Explicit isolated database only; never discover developer .env credentials.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/weletic/flow-action-db.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    setupFiles: ["./tests/setupTests.ts"],
  },
});
