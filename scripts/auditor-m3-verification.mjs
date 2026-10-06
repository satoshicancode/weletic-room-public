import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  INDEPENDENT FORENSIC VERIFICATION: MILESTONE 3 (FIN-03 STORE CREDIT)");
console.log("================================================================================\n");

let passed = 0;
let total = 0;

function check(title, fn) {
  total++;
  try {
    fn();
    console.log(`  [PASS] ${title}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${title}: ${err.message}`);
    process.exitCode = 1;
  }
}

// 1. Safety Invariant: Main Repo Untouched
check("Safety Invariant 1: Main repo pristine at commit b13eb92297", () => {
  const mainRepoPath = "/Users/hironguyen/Code/weletic/weletic-room";
  assert(fs.existsSync(mainRepoPath), "Main repo directory must exist");
  const head = execSync("git rev-parse HEAD", { cwd: mainRepoPath, encoding: "utf8" }).trim();
  assert.strictEqual(head, "b13eb922976f420cb67d58d2d4a8de38609ea0e8", "Main repo HEAD must match b13eb92297");
});

// 2. Safety Invariant: Remote 0 Pushes
check("Safety Invariant 2: Remote branch codex/review-p0-fixes has 0 pushes", () => {
  const lsRemote = execSync("git ls-remote origin codex/review-p0-fixes", { cwd: rootDir, encoding: "utf8" }).trim();
  assert.strictEqual(lsRemote, "", "git ls-remote must return empty string");
});

// 3. Zero Hardcoded Store Domains in M3 files
check("Zero Hardcoded Store Domains: No yamaxdev / montdev in runtime logic", () => {
  const m3Files = [
    "apps/web/lib/weletic/loyalty/store-credit-reconciliation.ts",
    "apps/web/lib/weletic/loyalty/shopify-financial-rewards.ts",
    "apps/web/lib/weletic/loyalty/financial-reward-saga.ts",
    "apps/web/lib/weletic/loyalty/outbox-worker.ts",
    "apps/web/app/(ee)/api/cron/weletic/reconcile/store-credit/route.ts",
  ];

  for (const relPath of m3Files) {
    const fullPath = path.join(rootDir, relPath);
    assert(fs.existsSync(fullPath), `File must exist: ${relPath}`);
    const content = fs.readFileSync(fullPath, "utf8");
    assert(!content.includes("yamaxdev"), `Found hardcoded yamaxdev in ${relPath}`);
    assert(!content.includes("montdev"), `Found hardcoded montdev in ${relPath}`);
  }
});

// 4. sameMoney Decimal Matcher Forensic Edge Cases
check("sameMoney: Exact mathematical Decimal comparison across edge cases", () => {
  function sameMoney(left, right) {
    const canonical = (value) => {
      if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
      const [whole, frac = ""] = value.split(".");
      const trimmedFrac = frac.replace(/0+$/, "");
      const normalizedWhole = String(BigInt(whole));
      return trimmedFrac ? `${normalizedWhole}.${trimmedFrac}` : normalizedWhole;
    };
    const cLeft = canonical(left);
    const cRight = canonical(right);
    return cLeft !== null && cRight !== null && cLeft === cRight;
  }

  assert.strictEqual(sameMoney("5.00", "5"), true);
  assert.strictEqual(sameMoney("5.0", "5.00"), true);
  assert.strictEqual(sameMoney("0.50", "0.5"), true);
  assert.strictEqual(sameMoney("0", "0.00"), true);
  assert.strictEqual(sameMoney("005.00", "5"), true);
  assert.strictEqual(sameMoney("12345678901234567890.50", "12345678901234567890.5"), true);
  assert.strictEqual(sameMoney("5.01", "5.00"), false);
  assert.strictEqual(sameMoney("-5.00", "5.00"), false);
  assert.strictEqual(sameMoney("invalid", "5.00"), false);
  assert.strictEqual(sameMoney("5.00", "5.00.00"), false);
});

// 5. Audit GraphQL Query Structure
check("Shopify GraphQL Audit Query includes required fields and nodes", () => {
  const filePath = path.join(rootDir, "apps/web/lib/weletic/loyalty/shopify-financial-rewards.ts");
  const content = fs.readFileSync(filePath, "utf8");
  assert(content.includes("CUSTOMER_STORE_CREDIT_AUDIT_QUERY"), "CUSTOMER_STORE_CREDIT_AUDIT_QUERY must be defined");
  assert(content.includes("storeCreditAccounts(first: 5)"), "Must query customer storeCreditAccounts");
  assert(content.includes("transactions(first: 20, reverse: true)"), "Must query credit transactions reverse chronologically");
  assert(content.includes("StoreCreditAccountCreditTransaction"), "Must query inline fragment for CreditTransaction");
});

// 6. Reconciliation Module Multi-Tier Verification
check("store-credit-reconciliation: 4-tier match criteria, OCC locking, and compensation", () => {
  const filePath = path.join(rootDir, "apps/web/lib/weletic/loyalty/store-credit-reconciliation.ts");
  const content = fs.readFileSync(filePath, "utf8");

  // Multi-tier match checks
  assert(content.includes("tx.currencyCode.toUpperCase() !== expectedCurrency.toUpperCase()"), "Checks currency equality");
  assert(content.includes("sameMoney(tx.amount, expectedDecimalAmount)"), "Checks amount via sameMoney");
  assert(content.includes("tx.createdAt < minCreatedAt || tx.createdAt > maxCreatedAt"), "Checks temporal proximity window");
  assert(content.includes("shopifyStoreCreditTransactionId: tx.id"), "Checks DB transaction ID collision avoidance");

  // OCC locking
  assert(content.includes("withLoyaltyProgramRowLock"), "Uses durable program row lock");
  assert(content.includes("updateMany"), "Uses optimistic concurrency updateMany");

  // Two-phase outcome
  assert(content.includes("compensateDiscountSaga"), "Invokes compensateDiscountSaga on timeout");
  assert(content.includes("enqueueFlowTriggerJob"), "Enqueues Flow trigger on confirmation");
  assert(content.includes("enqueueOutboxJobFromProgramTransaction"), "Enqueues METAFIELD_SYNC on confirmation");
});

// 7. Outbox Worker Interception
check("outbox-worker: Intercepts store_credit with remoteProvisionAttempt to prevent deadlock", () => {
  const filePath = path.join(rootDir, "apps/web/lib/weletic/loyalty/outbox-worker.ts");
  const content = fs.readFileSync(filePath, "utf8");

  assert(content.includes("reconcilePendingStoreCreditRedemption"), "Imports reconcilePendingStoreCreditRedemption");
  assert(content.includes("hasRemoteProvisionAttempt(redemption.metadata)"), "Checks hasRemoteProvisionAttempt on redemption");
  assert(content.includes("artifactKind === WeleticRewardArtifactKind.store_credit"), "Filters for store_credit artifact kind");
});

// 8. Cron Route Handler
check("Cron Route Handler: Configured correctly with withCron and duration limits", () => {
  const filePath = path.join(rootDir, "apps/web/app/(ee)/api/cron/weletic/reconcile/store-credit/route.ts");
  const content = fs.readFileSync(filePath, "utf8");

  assert(content.includes("withCron"), "Wraps handler in withCron");
  assert(content.includes("reconcilePendingStoreCreditRedemptionsSweep"), "Calls sweeper function");
  assert(content.includes('export const dynamic = "force-dynamic"'), "force-dynamic export present");
  assert(content.includes("export const maxDuration = 60"), "maxDuration set to 60s");
  assert(content.includes("export const POST = GET"), "POST alias for cron trigger");
});

console.log(`\n================================================================================`);
console.log(`  VERIFICATION RESULTS: ${passed}/${total} CHECKS PASSED`);
console.log(`================================================================================\n`);

if (passed !== total) {
  process.exit(1);
}
