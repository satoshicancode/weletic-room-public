import { loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  esbuild: { jsx: "automatic" },
  test: {
    dir: "./tests",
    include: ["**/*.integration.test.{ts,tsx}"],
    environment: "node",
    reporters: ["verbose"],
    globals: true,
    testTimeout: 30000,
    env: {
      ...loadEnv("", process.cwd(), ""),
      E2E_BASE_URL: process.env.E2E_BASE_URL || "http://localhost:3000",
      E2E_TOKEN: process.env.E2E_TOKEN || "test_e2e_token",
      E2E_TOKEN_MEMBER: process.env.E2E_TOKEN_MEMBER || "test_e2e_token_member",
      E2E_TOKEN_OLD: process.env.E2E_TOKEN_OLD || "test_e2e_token_old",
      E2E_PUBLISHABLE_KEY: process.env.E2E_PUBLISHABLE_KEY || "test_e2e_publishable_key",
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || "https://upstash.invalid",
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || "offline_test_token",
    },
    setupFiles: ["./tests/setupTests.ts"],
  },
});
