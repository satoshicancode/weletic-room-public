import { defineConfig } from "vitest/config";

// Keep Shopify UI types in their owning package rather than importing Polaris
// and Remix route modules into the web application's TypeScript program.
export default defineConfig({
  test: {
    include: ["test-support/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
