import "dotenv-flow/config";

import { defineConfig, devices } from "@playwright/test";
import { assertLocalDatabaseEnv } from "./playwright/assert-local-database";

assertLocalDatabaseEnv();

const workspaceBaseURL = "http://localhost:8888";
const partnersBaseURL = "http://partners.localhost:8888";

export default defineConfig({
  globalSetup: require.resolve("./playwright/global-setup"),
  testDir: "./playwright",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report" }]]
    : [
        ["list"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
      ],
  expect: {
    timeout: 30000,
  },
  use: {
    baseURL: workspaceBaseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // API tests (Bearer token seeded in globalSetup)
    {
      name: "api",
      testDir: "./playwright/api",
      fullyParallel: true,
      use: {
        baseURL: workspaceBaseURL,
      },
    },
    {
      name: "shopify-rewards",
      testDir: "./playwright/shopify-rewards",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: workspaceBaseURL,
        channel: "chrome",
      },
    },
    // Partner tests
    {
      name: "partner-setup",
      testMatch: /partners\/auth\.setup\.ts/,
      use: {
        baseURL: partnersBaseURL,
      },
    },
    {
      name: "partners",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: partnersBaseURL,
        storageState: "playwright/.auth/partner.json",
      },
      testDir: "./playwright/partners",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["partner-setup"],
    },
    // Workspace tests
    {
      name: "workspaces",
      use: {
        ...devices["Desktop Chrome"],
      },
      testDir: "./playwright/workspaces",
      testIgnore: /auth\.setup\.ts|billing-trial\.spec\.ts/,
    },
    // Billing tests create their own authenticated workspace per attempt.
    {
      name: "chromium-workspace",
      testMatch: /workspaces\/billing-trial\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: "pnpm start -p 8888",
    port: 8888,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    env: {
      PLAYWRIGHT_TEST: "1",
      WELETIC_ALLOW_LOCAL_SQLITE: "1",
    },
  },
});
