import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  CHALLENGER 1 FINAL GATE: ADVERSARIAL API VERSION & MONOREPO CONSISTENCY");
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

// 1. Static Scan: Zero sunset "2025-01" in Shopify configs, TOMLs, clients
check("Scan 1: Zero sunset '2025-01' in active Shopify configuration & runtime clients", () => {
  const sensitiveFiles = [
    "apps/web/lib/integrations/shopify/admin-graphql.ts",
    "apps/web/.env.example",
    "packages/shopify-app/app/shopify.server.ts",
    "packages/shopify-app/test-support/online-token-exchange.ts",
    "packages/shopify-app/shopify.app.toml",
    "packages/shopify-app/shopify.app.loyalty-public.toml",
    "packages/shopify-app/extensions/loyalty-checkout-slider/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-customer-account-blocks/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-customer-account/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-free-product/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-free-product/schema.graphql",
    "packages/shopify-app/extensions/weletic-pos-loyalty/shopify.extension.toml",
  ];

  for (const relPath of sensitiveFiles) {
    const fullPath = path.join(rootDir, relPath);
    assert(fs.existsSync(fullPath), `File must exist: ${relPath}`);
    const content = fs.readFileSync(fullPath, "utf8");
    assert(!content.includes("2025-01"), `${relPath} must NOT contain sunset version '2025-01'`);
    assert(!content.includes("January25"), `${relPath} must NOT contain ApiVersion.January25`);
  }
});

// 2. All sensitive files contain "2026-10"
check("Scan 2: All active Shopify configs and manifests explicitly target '2026-10'", () => {
  const targetFiles = [
    { file: "apps/web/lib/integrations/shopify/admin-graphql.ts", needle: '"2026-10"' },
    { file: "apps/web/.env.example", needle: "SHOPIFY_ADMIN_API_VERSION=2026-10" },
    { file: "packages/shopify-app/app/shopify.server.ts", needle: '"2026-10"' },
    { file: "packages/shopify-app/test-support/online-token-exchange.ts", needle: '"2026-10"' },
    { file: "packages/shopify-app/shopify.app.toml", needle: 'api_version = "2026-10"' },
    { file: "packages/shopify-app/shopify.app.loyalty-public.toml", needle: 'api_version = "2026-10"' },
    { file: "packages/shopify-app/extensions/loyalty-checkout-slider/shopify.extension.toml", needle: 'api_version = "2026-10"' },
    { file: "packages/shopify-app/extensions/weletic-customer-account-blocks/shopify.extension.toml", needle: 'api_version = "2026-10"' },
    { file: "packages/shopify-app/extensions/weletic-customer-account/shopify.extension.toml", needle: 'api_version = "2026-10"' },
    { file: "packages/shopify-app/extensions/weletic-free-product/shopify.extension.toml", needle: 'api_version = "2026-10"' },
    { file: "packages/shopify-app/extensions/weletic-pos-loyalty/shopify.extension.toml", needle: 'api_version = "2026-10"' },
  ];

  for (const { file, needle } of targetFiles) {
    const fullPath = path.join(rootDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    assert(content.includes(needle), `${file} must contain '${needle}'`);
  }
});

// 3. Manifest sha256 checksum integrity
check("Scan 3: Staging script manifest hashes match extension TOML content", () => {
  const stagingScript = fs.readFileSync(path.join(rootDir, "infra/shopify-development/stage-public-extensions.mjs"), "utf8");

  const extensions = [
    { name: "weletic-customer-account", path: "packages/shopify-app/extensions/weletic-customer-account/shopify.extension.toml" },
    { name: "weletic-customer-account-blocks", path: "packages/shopify-app/extensions/weletic-customer-account-blocks/shopify.extension.toml" },
    { name: "loyalty-checkout-slider", path: "packages/shopify-app/extensions/loyalty-checkout-slider/shopify.extension.toml" },
  ];

  for (const ext of extensions) {
    const content = fs.readFileSync(path.join(rootDir, ext.path));
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    assert(stagingScript.includes(sha), `stage-public-extensions.mjs must contain exact hash ${sha} for ${ext.name}`);
  }
});

// 4. Verify scripts/verify-milestone1.mjs passes
check("Execution 1: scripts/verify-milestone1.mjs passes 9/9 checks", () => {
  const output = execSync("node scripts/verify-milestone1.mjs", { cwd: rootDir, encoding: "utf8" });
  assert(output.includes("TOTAL CHECKS: 9"), "verify-milestone1.mjs must run 9 checks");
  assert(output.includes("PASSED:       9"), "verify-milestone1.mjs must pass all 9 checks");
  assert(output.includes("FAILED:       0"), "verify-milestone1.mjs must have 0 failures");
  assert(output.includes("VERDICT: PASS"), "verify-milestone1.mjs verdict must be PASS");
});

// 5. Invariant Safety Check: Main repo untouched
check("Safety 1: Main repository commit HEAD is pristine", () => {
  const mainRepoHead = execSync("git -C /Users/hironguyen/Code/weletic/weletic-room rev-parse HEAD", { encoding: "utf8" }).trim();
  assert.strictEqual(mainRepoHead, "b13eb922976f420cb67d58d2d4a8de38609ea0e8", "Main repo HEAD must be b13eb922976f420cb67d58d2d4a8de38609ea0e8");
});

// 6. Invariant Safety Check: No remote push
check("Safety 2: Remote repository branch has not been pushed", () => {
  const remoteOutput = execSync("git ls-remote origin codex/review-p0-fixes", { cwd: rootDir, encoding: "utf8" }).trim();
  assert.strictEqual(remoteOutput, "", "git ls-remote must return empty");
});

// 7. Neutral brand template check (Invariant 4)
check("Safety 3: Email reminder default brand is neutral 'Rewards Club'", () => {
  const emailContent = fs.readFileSync(path.join(rootDir, "packages/email/src/templates/points-expiry-reminder.tsx"), "utf8");
  assert(!emailContent.includes('brandName = "Yamax"'), "Must not hardcode Yamax");
  assert(emailContent.includes('brandName = "Rewards Club"'), "Must default to Rewards Club");
});

console.log("\n================================================================================");
console.log(`TOTAL GATE CHECKS: ${total}`);
console.log(`PASSED:            ${passed}`);
console.log(`FAILED:            ${total - passed}`);
console.log("================================================================================\n");

if (passed === total) {
  console.log("CHALLENGER FINAL GATE VERDICT: APPROVE\n");
} else {
  process.exit(1);
}
