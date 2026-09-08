import { loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
import { VITEST_TEST_TIMEOUT_MS } from "./lib/constants/misc";

export default defineConfig({
  plugins: [tsconfigPaths()],
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
