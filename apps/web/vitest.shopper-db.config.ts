import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// No dotenv discovery. Only the explicitly guarded isolated database is valid.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/weletic/shopper-profile-db.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
