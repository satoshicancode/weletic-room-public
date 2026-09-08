import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// No dotenv discovery: this suite accepts only the guarded isolated database.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/weletic/module-lifecycle-db.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
