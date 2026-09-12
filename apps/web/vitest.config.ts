import { loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
import { VITEST_TEST_TIMEOUT_MS } from "./lib/constants/misc";

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Match Next.js's JSX runtime. Import organization correctly removes unused
  // React default imports; classic JSX evaluation would then fail only in tests.
  esbuild: { jsx: "automatic" },
  test: {
    dir: "./tests",
    include: ["**/*.test.{ts,tsx}"],
    exclude: [
      "**/*.integration.test.{ts,tsx}",
      "**/*.performance.test.{ts,tsx}",
    ],
    reporters: ["verbose"],
    globals: true,
    testTimeout: VITEST_TEST_TIMEOUT_MS,
    env: loadEnv("", process.cwd(), ""),
    setupFiles: ["./tests/setupTests.ts"],
  },
});
