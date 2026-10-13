import path from "node:path";
import { defineConfig } from "vitest/config";

// Keep Shopify UI types in their owning package rather than importing Polaris
// and Remix route modules into the web application's TypeScript program.
export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./app"),
    },
  },
  test: {
    include: ["test-support/**/*.test.ts"],
    environment: "node",
    pool: "threads",
    testTimeout: 10_000,
  },
});
