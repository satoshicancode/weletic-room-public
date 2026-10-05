import { execSync } from "child_process";
import fs from "fs";
import path from "path";

console.log("=== CHALLENGER 2: EMPIRICAL AUDIT & STRESS SUITE ===\n");

const testsToProbe = [
  "tests/weletic/provision-webhooks.test.ts",
  "tests/weletic/shopify-app-pricing.test.ts",
  "tests/weletic/flow-action-handler.test.ts",
  "tests/weletic/shopify-segment-webhooks.test.ts",
  "tests/weletic/loyalty-admin-api.test.ts",
  "tests/weletic/points-expiry-email-localization.test.tsx",
  "tests/weletic/shopify-discount-saga.test.ts",
  "tests/weletic/shopify-catalog-compliance-fence.test.ts",
  "tests/weletic/loyalty-outbox-worker-cli.test.ts",
  "tests/weletic/non-purchase-earn.test.ts",
  "tests/weletic/test-store-validation-harness.test.ts",
];

const results = [];

for (const testPath of testsToProbe) {
  process.stdout.write(`Testing: ${testPath}... `);
  try {
    const cmd = `pnpm --filter web exec vitest run --config vitest.config.ts --bail=1 ${testPath}`;
    const output = execSync(cmd, {
      stdio: "pipe",
      env: { ...process.env, UPSTASH_REDIS_REST_URL: "https://upstash.invalid" },
    }).toString();
    console.log("PASSED");
    results.push({ testPath, passed: true, error: null });
  } catch (err) {
    console.log("FAILED");
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    const combined = stdout + "\n" + stderr;
    const failureMatch = combined.match(/AssertionError:[^\n]+/i) || combined.match(/FAIL[^\n]+/i);
    results.push({
      testPath,
      passed: false,
      error: failureMatch ? failureMatch[0] : "Test failed",
      outputSnippet: combined.slice(-500),
    });
  }
}

console.log("\n=== TEST RUN SUMMARY ===");
let failCount = 0;
for (const r of results) {
  if (r.passed) {
    console.log(`✓ PASS: ${r.testPath}`);
  } else {
    failCount++;
    console.log(`✗ FAIL: ${r.testPath} -> ${r.error}`);
  }
}

console.log(`\nTotal: ${results.length}, Passed: ${results.length - failCount}, Failed: ${failCount}`);
if (failCount > 0) {
  console.log(`\nCRITICAL FINDING: ${failCount} existing test suites failed due to API version changes!`);
}
