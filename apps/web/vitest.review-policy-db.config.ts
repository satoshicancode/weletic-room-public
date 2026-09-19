import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// No dotenv discovery; the suite verifies its disposable database principal.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/weletic/review-policy-db.integration.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    setupFiles: ["./tests/setupTests.ts"],
  },
});
