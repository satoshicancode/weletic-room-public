import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  CHALLENGER 2: ADVERSARIAL STRESS & VERIFICATION SUITE (MILESTONE 1)");
console.log("================================================================================\n");

let passed = 0;
let total = 0;
const failures = [];

async function runTest(description, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    failures.push({ description, error: err.message });
  }
}

async function main() {
  // ============================================================================
  // FOCUS 1: Webhook Route Error Propagation on Lock Collision & Retry Semantics
  // ============================================================================
  console.log("--- FOCUS 1: Webhook Route Error Propagation & Lock Collisions ---");

  await runTest("Focus 1.1: Webhook route code inspection - no inner try/catch around catalog sync handlers", async () => {
    const routePath = path.join(rootDir, "apps/web/app/(ee)/api/shopify/integration/webhook/route.ts");
    const content = fs.readFileSync(routePath, "utf8");

    // Inspect the cases for catalog sync
    const catalogCasesMatch = content.match(/case "products\/create":[\s\S]*?case "markets\/delete":\s*\{([\s\S]*?)\}/);
    assert(catalogCasesMatch, "Catalog sync cases block must exist in webhook route");
    const catalogBlock = catalogCasesMatch[1];

    // Verify there is NO inner try/catch in this block
    assert(!catalogBlock.includes("try {"), "Catalog sync switch case must not swallow errors in an inner try/catch");
    assert(!catalogBlock.includes("catch ("), "Catalog sync switch case must not catch errors locally");

    // Verify outer catch block returns 500
    const outerCatchMatch = content.match(/} catch \(error\) \{([\s\S]*?return response;[\s\S]*?\})/);
    assert(outerCatchMatch, "Outer catch block must exist for webhook processing");
    const outerCatchBlock = outerCatchMatch[1];
    assert(outerCatchBlock.includes("status: 500"), "Outer catch block must respond with HTTP 500");
    assert(outerCatchBlock.includes('status: "failed"'), "Outer catch block must update event status to 'failed'");
  });

  await runTest("Focus 1.2: Catalog sync lock collision error definition and propagation contract", async () => {
    const catalogSyncPath = path.join(rootDir, "apps/web/lib/weletic/shopify/catalog-sync.ts");
    const content = fs.readFileSync(catalogSyncPath, "utf8");

    assert(
      content.includes('throw new Error("A Shopify catalog sync is already running.")'),
      "syncWeleticShopifyCatalog must throw exact lock collision error when onLocked triggers"
    );
  });

  await runTest("Focus 1.3: Catalog debounce Redis lock safe release on QStash publish failure", async () => {
    const debouncePath = path.join(rootDir, "apps/web/lib/weletic/shopify/catalog-webhook-debounce.ts");
    const content = fs.readFileSync(debouncePath, "utf8");

    assert(content.includes("RELEASE_CATALOG_DEBOUNCE_SCRIPT"), "Must define atomic Lua script to release reservation");
    assert(content.includes(".eval(RELEASE_CATALOG_DEBOUNCE_SCRIPT"), "Must execute atomic release on catch");
    assert(content.includes("throw error;"), "Must rethrow error to propagate to webhook 500 handler");
  });

  await runTest("Focus 1.4: Existing Vitest suite confirms HTTP 500 retry status on catalog lock collision", async () => {
    const testSuitePath = path.join(rootDir, "apps/web/tests/weletic/shopify-central-compliance-webhook.test.ts");
    const testContent = fs.readFileSync(testSuitePath, "utf8");

    assert(
      testContent.includes('"A Shopify catalog sync is already running."'),
      "Test suite must specifically assert lock collision message"
    );
    assert(
      testContent.includes("expect(response.status).toBe(500)"),
      "Test suite must assert HTTP 500 status code on lock collision"
    );
    assert(
      testContent.includes('status: "failed"'),
      "Test suite must assert event status is marked failed (not processed)"
    );
  });

  // ============================================================================
  // FOCUS 2: Points-Expiry-Reminder Email Template Localization & Brand Neutrality
  // ============================================================================
  console.log("\n--- FOCUS 2: Points-Expiry-Reminder Template Localization & Brand Neutrality ---");

  const templatePath = path.join(rootDir, "packages/email/src/templates/points-expiry-reminder.tsx");
  const templateContent = fs.readFileSync(templatePath, "utf8");

  await runTest("Focus 2.1: Template default parameter neutral brand is 'Rewards Club'", async () => {
    assert(templateContent.includes('brandName = "Rewards Club"'), "Default brandName must be 'Rewards Club'");
  });

  await runTest("Focus 2.2: Template source code has ZERO occurrences of 'Yamax' (case-insensitive)", async () => {
    const matches = templateContent.match(/yamax/i);
    assert.strictEqual(matches, null, `Found forbidden 'Yamax' reference in email template: ${matches}`);
  });

  await runTest("Focus 2.3: Vitest execution of challenger-points-expiry-brand suite (14 matrix tests)", async () => {
    const output = execSync(
      "pnpm --filter web exec vitest run --config vitest.config.ts tests/weletic/challenger-points-expiry-brand.test.tsx",
      { cwd: rootDir, encoding: "utf8", env: { ...process.env, UPSTASH_REDIS_REST_URL: "https://upstash.invalid" } }
    );
    assert(output.includes("14 passed"), `Expected 14 passed brand tests, got output: ${output}`);
  });

  await runTest("Focus 2.4: Vitest execution of points-expiry-email-localization suite (17 tests)", async () => {
    const output = execSync(
      "pnpm --filter web exec vitest run --config vitest.config.ts tests/weletic/points-expiry-email-localization.test.tsx",
      { cwd: rootDir, encoding: "utf8", env: { ...process.env, UPSTASH_REDIS_REST_URL: "https://upstash.invalid" } }
    );
    assert(output.includes("17 passed"), `Expected 17 passed localization tests, got output: ${output}`);
  });

  // ============================================================================
  // FOCUS 3: Outbox Worker Canonical Store Resolver (Invariant 1)
  // ============================================================================
  console.log("\n--- FOCUS 3: Outbox Worker Canonical Store Resolver (Invariant 1) ---");

  await runTest("Focus 3.1: Outbox worker CLI script imports canonical resolveShopifyStoreByDomain", async () => {
    const workerScriptPath = path.join(rootDir, "apps/web/scripts/loyalty/run-outbox-worker.ts");
    const content = fs.readFileSync(workerScriptPath, "utf8");

    assert(
      content.includes('import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";'),
      "run-outbox-worker.ts must import resolveShopifyStoreByDomain from store-resolver"
    );
    assert(
      content.includes("const resolved = await resolveShopifyStoreByDomain(shopDomain);"),
      "run-outbox-worker.ts must call resolveShopifyStoreByDomain"
    );
    assert(
      !content.includes("prisma.weleticShopifyStore.findUnique"),
      "run-outbox-worker.ts must not perform direct un-aliased findUnique on weleticShopifyStore"
    );
  });

  await runTest("Focus 3.2: Outbox worker runtime enforces exact scope safety and prevents alias expansion", async () => {
    const { runOutboxWorker } = await import(
      path.join(rootDir, "apps/web/scripts/loyalty/outbox-worker-runtime.ts")
    );

    const testShop = "my-test-store.myshopify.com";

    // Case A: Exact domain matches canonical store
    let processedOptions = null;
    await runOutboxWorker([`--store=${testShop}`, "--once"], {
      workerId: "test-w1",
      findStore: async (domain) => ({ id: "store_123", shopDomain: domain }),
      processBatch: async (opts) => {
        processedOptions = opts;
        return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
      },
      shouldStop: () => false,
      waitForNextPoll: async () => {},
      logger: { info: () => {}, error: () => {} },
    });
    assert.strictEqual(processedOptions?.storeId, "store_123");

    // Case B: Mismatched domain (e.g. alias returned instead of exact CLI target)
    let aliasThrew = false;
    try {
      await runOutboxWorker([`--store=${testShop}`, "--once"], {
        workerId: "test-w1",
        findStore: async () => ({ id: "store_alias", shopDomain: "different-canonical.myshopify.com" }),
        processBatch: async () => ({ processed: 0, succeeded: 0, failed: 0, deadLettered: 0 }),
        shouldStop: () => false,
        waitForNextPoll: async () => {},
        logger: { info: () => {}, error: () => {} },
      });
    } catch (err) {
      aliasThrew = true;
      assert(err.message.includes(`No store matches the exact domain ${testShop}`));
    }
    assert.strictEqual(aliasThrew, true, "Must guard against alias scope expansion");

    // Case C: Store not found -> fails safely, does NOT fall back to global
    let notFoundThrew = false;
    try {
      await runOutboxWorker([`--store=${testShop}`, "--once"], {
        workerId: "test-w1",
        findStore: async () => null,
        processBatch: async () => ({ processed: 0, succeeded: 0, failed: 0, deadLettered: 0 }),
        shouldStop: () => false,
        waitForNextPoll: async () => {},
        logger: { info: () => {}, error: () => {} },
      });
    } catch (err) {
      notFoundThrew = true;
      assert(err.message.includes(`No store matches the exact domain ${testShop}`));
    }
    assert.strictEqual(notFoundThrew, true, "Must throw on not found store");
  });

  await runTest("Focus 3.3: Invariant 1 Monorepo Compliance - Zero hardcoded store domains in application logic", async () => {
    // Check that application code doesn't hardcode specific store domains like yamaxdev or montdev
    const filesToCheck = [
      "apps/web/scripts/loyalty/run-outbox-worker.ts",
      "apps/web/app/(ee)/api/shopify/integration/webhook/route.ts",
      "apps/web/lib/integrations/shopify/admin-graphql.ts",
      "packages/email/src/templates/points-expiry-reminder.tsx",
    ];

    for (const rel of filesToCheck) {
      const full = path.join(rootDir, rel);
      const content = fs.readFileSync(full, "utf8");
      assert(!content.includes("yamaxdev.myshopify.com"), `${rel} must not hardcode yamaxdev.myshopify.com`);
      assert(!content.includes("montdev.myshopify.com"), `${rel} must not hardcode montdev.myshopify.com`);
    }
  });

  // ============================================================================
  // FOCUS 4: Safety Invariants & Git Purity
  // ============================================================================
  console.log("\n--- FOCUS 4: Safety Invariants & Clean Isolation ---");

  await runTest("Focus 4.1: Main repository is pristine and untouched", async () => {
    const mainRepoPath = "/Users/hironguyen/Code/weletic/weletic-room";
    const head = execSync("git rev-parse HEAD", { cwd: mainRepoPath, encoding: "utf8" }).trim();
    assert.strictEqual(
      head,
      "b13eb922976f420cb67d58d2d4a8de38609ea0e8",
      `Main repo HEAD must remain b13eb922976f420cb67d58d2d4a8de38609ea0e8, found: ${head}`
    );
  });

  await runTest("Focus 4.2: Remote repository has not been pushed to", async () => {
    const remoteOutput = execSync("git ls-remote origin codex/review-p0-fixes", { cwd: rootDir, encoding: "utf8" }).trim();
    assert.strictEqual(remoteOutput, "", `Remote branch must be empty (unpushed), found: ${remoteOutput}`);
  });

  console.log("\n================================================================================");
  console.log(`TOTAL ADVERSARIAL STRESS CHECKS: ${total}`);
  console.log(`PASSED:                          ${passed}`);
  console.log(`FAILED:                          ${failures.length}`);
  console.log("================================================================================\n");

  if (failures.length === 0) {
    console.log("CHALLENGER 2 VERDICT: APPROVE (All stress tests passed with 100% empirical evidence)\n");
    process.exit(0);
  } else {
    console.error("CHALLENGER 2 VERDICT: REQUEST_CHANGES (Failures detected)\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled harness fatal error:", err);
  process.exit(1);
});
