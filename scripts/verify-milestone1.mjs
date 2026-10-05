import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  EMPIRICAL VERIFICATION: PHASE 3 MILESTONE 1 (FOUNDATIONAL CLEANUPS)");
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

// 1. PKG-02
check("PKG-02: packages/tailwind-config package.json and index.ts entrypoint resolution", () => {
  const pkgPath = path.join(rootDir, "packages/tailwind-config/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.strictEqual(pkg.main, "tailwind.config.ts", "pkg.main should be tailwind.config.ts");
  assert.strictEqual(pkg.types, "tailwind.config.ts", "pkg.types should be tailwind.config.ts");
  assert(pkg.exports && pkg.exports["."], "pkg.exports['.'] should be defined");
  const indexPath = path.join(rootDir, "packages/tailwind-config/index.ts");
  assert(fs.existsSync(indexPath), "packages/tailwind-config/index.ts must exist");
  const indexContent = fs.readFileSync(indexPath, "utf8");
  assert(indexContent.includes('export { default } from "./tailwind.config"'), "index.ts must re-export default");
});

// 2. PKG-03
check("PKG-03: Hoist pnpm.overrides to root package.json and remove sub-package overrides", () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert(!rootPkg.resolutions, "root package.json should not have resolutions");
  assert(rootPkg.pnpm && rootPkg.pnpm.overrides, "root package.json must have pnpm.overrides");
  assert.strictEqual(rootPkg.pnpm.overrides["chrono-node"], "2.7.5");
  assert.strictEqual(rootPkg.pnpm.overrides["@types/react"], "19.1.14");
  assert.strictEqual(rootPkg.pnpm.overrides["@types/react-dom"], "19.1.9");

  const webPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "apps/web/package.json"), "utf8"));
  assert(!webPkg.pnpm, "apps/web/package.json must not declare pnpm.overrides");
});

// 3. PKG-04 & PKG-05
check("PKG-04 & PKG-05: Foreign lockfile removal & orphan packages archived", () => {
  assert(!fs.existsSync(path.join(rootDir, "packages/stripe-app/package-lock.json")), "package-lock.json in packages/stripe-app must not exist");
  assert(!fs.existsSync(path.join(rootDir, "archive/packages/stripe-app/package-lock.json")), "package-lock.json in archive must not exist");

  const orphanPackages = ["stripe-app", "hubspot-app", "cli", "tinybird"];
  for (const pkg of orphanPackages) {
    assert(!fs.existsSync(path.join(rootDir, "packages", pkg)), `packages/${pkg} must not exist`);
    assert(fs.existsSync(path.join(rootDir, "archive/packages", pkg)), `archive/packages/${pkg} must exist`);
  }

  // Check Dockerfiles
  const dockerfiles = [
    "infra/cloudflare-release/Web.Dockerfile",
    "infra/cloudflare-release/Shopify.Dockerfile",
    "infra/cloudflare-local/Dockerfile",
  ];
  for (const df of dockerfiles) {
    const content = fs.readFileSync(path.join(rootDir, df), "utf8");
    for (const orphan of orphanPackages) {
      assert(!content.includes(`COPY packages/${orphan}/`), `${df} must not COPY packages/${orphan}`);
    }
  }
});

// 4. PKG-06
check("PKG-06: Neutralize default brandName in email template", () => {
  const emailTemplate = fs.readFileSync(path.join(rootDir, "packages/email/src/templates/points-expiry-reminder.tsx"), "utf8");
  assert(!emailTemplate.includes('brandName = "Yamax"'), 'Template must not contain brandName = "Yamax"');
  assert(emailTemplate.includes('brandName = "Rewards Club"'), 'Template must have tenant-neutral fallback');
});

// 5. INFRA-02
check("PKG-05 / INFRA-02: Obsolete apps/web/docker-compose.yml deleted and README updated", () => {
  assert(!fs.existsSync(path.join(rootDir, "apps/web/docker-compose.yml")), "apps/web/docker-compose.yml must not exist");
  const readme = fs.readFileSync(path.join(rootDir, "apps/web/playwright/README.md"), "utf8");
  assert(!readme.includes("apps/web/docker-compose.yml"), "playwright/README.md must not reference deleted docker-compose.yml");
});

// 6. INFRA-04
check("INFRA-04: turbo.json outputs includes build/** for Remix caching", () => {
  const turboJson = JSON.parse(fs.readFileSync(path.join(rootDir, "turbo.json"), "utf8"));
  assert(turboJson.pipeline.build.outputs.includes("build/**"), "turbo.json build outputs must include build/**");
});

// 7. ARCH-05 & ARCH-06
check("ARCH-05 & ARCH-06: Dead isLocalDev condition removed from webhook route.ts", () => {
  const routeContent = fs.readFileSync(path.join(rootDir, "apps/web/app/(ee)/api/shopify/integration/webhook/route.ts"), "utf8");
  assert(!routeContent.includes("isLocalDev &&\n    !signedTenantTopics.has(topic)"), "Dead isLocalDev condition must be removed");
  assert(!fs.existsSync(path.join(rootDir, "apps/web/app/api/integrations/shopify")), "apps/web/app/api/integrations/shopify should not exist in worktree");
});

// 8. SYNC-04 / PERF-09 / ARCH-04
check("SYNC-04: Alignment to stable Shopify API version 2026-10 (Q4 2026 release)", () => {
  const adminGraphql = fs.readFileSync(path.join(rootDir, "apps/web/lib/integrations/shopify/admin-graphql.ts"), "utf8");
  assert(adminGraphql.includes('"2026-10"'), 'admin-graphql.ts must default to "2026-10"');
  assert(!adminGraphql.includes('"2025-01"'), 'admin-graphql.ts must not contain sunset "2025-01"');

  const shopifyServer = fs.readFileSync(path.join(rootDir, "packages/shopify-app/app/shopify.server.ts"), "utf8");
  assert(shopifyServer.includes('"2026-10"'), 'shopify.server.ts must target "2026-10"');
  assert(!shopifyServer.includes("ApiVersion.January25"), "shopify.server.ts must not use sunset ApiVersion.January25");

  const envExample = fs.readFileSync(path.join(rootDir, "apps/web/.env.example"), "utf8");
  assert(envExample.includes("SHOPIFY_ADMIN_API_VERSION=2026-10"), ".env.example must have SHOPIFY_ADMIN_API_VERSION=2026-10");

  // TOMLs
  const tomls = [
    "packages/shopify-app/shopify.app.toml",
    "packages/shopify-app/shopify.app.loyalty-public.toml",
    "packages/shopify-app/extensions/loyalty-checkout-slider/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-customer-account-blocks/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-customer-account/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-free-product/shopify.extension.toml",
    "packages/shopify-app/extensions/weletic-pos-loyalty/shopify.extension.toml",
  ];
  for (const t of tomls) {
    const tomlContent = fs.readFileSync(path.join(rootDir, t), "utf8");
    assert(tomlContent.includes('api_version = "2026-10"'), `${t} must declare api_version = "2026-10"`);
    assert(!tomlContent.includes('"2025-01"'), `${t} must not contain sunset "2025-01"`);
  }
});

// 9. SYNC-06
check("SYNC-06: run-outbox-worker.ts uses canonical resolveShopifyStoreByDomain", () => {
  const workerContent = fs.readFileSync(path.join(rootDir, "apps/web/scripts/loyalty/run-outbox-worker.ts"), "utf8");
  assert(workerContent.includes("resolveShopifyStoreByDomain"), "run-outbox-worker.ts must use resolveShopifyStoreByDomain");
});

console.log("\n================================================================================");
console.log(`TOTAL CHECKS: ${total}`);
console.log(`PASSED:       ${passed}`);
console.log(`FAILED:       ${total - passed}`);
console.log("================================================================================\n");

if (passed === total) {
  console.log("VERDICT: PASS (Milestone 1 Implementation 100% Complete & Verified)\n");
} else {
  process.exit(1);
}
