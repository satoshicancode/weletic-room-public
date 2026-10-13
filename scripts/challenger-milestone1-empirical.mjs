#!/usr/bin/env node
/**
 * Empirical Challenger Verification Harness for Milestone 1
 * Targets: PKG-02, PKG-03, PKG-06, INFRA-04
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  CHALLENGER 1: EMPIRICAL STRESS TEST FOR MILESTONE 1 (FOUNDATIONAL CLEANUPS)");
console.log("================================================================================\n");

let passed = 0;
let total = 0;
const failureLog = [];

function check(title, fn) {
  total++;
  try {
    fn();
    console.log(`  [PASS] ${title}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${title}: ${err.message}`);
    failureLog.push({ title, error: err.message });
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// 1. PKG-02: Tailwind Config Resolution & Exports
// -----------------------------------------------------------------------------
check("PKG-02 (Node ESM): Direct import of @dub/tailwind-config", async () => {
  const mod = await import("@dub/tailwind-config");
  assert(mod.default, "Must have default export");
  assert(Array.isArray(mod.default.content), "Tailwind config must have content array");
  assert(mod.default.theme && mod.default.theme.extend, "Tailwind config must have theme.extend");
  assert(Array.isArray(mod.default.plugins) && mod.default.plugins.length >= 4, "Tailwind config must have plugins");
});

check("PKG-02 (Node ESM Subpaths): Resolve subpaths without extension, with .ts, and themes.css", async () => {
  const rootResolved = import.meta.resolve("@dub/tailwind-config");
  const noExtResolved = import.meta.resolve("@dub/tailwind-config/tailwind.config");
  const tsExtResolved = import.meta.resolve("@dub/tailwind-config/tailwind.config.ts");
  const themesResolved = import.meta.resolve("@dub/tailwind-config/themes.css");

  assert(rootResolved.endsWith("/packages/tailwind-config/tailwind.config.ts"), `Root resolved to unexpected path: ${rootResolved}`);
  assert(noExtResolved.endsWith("/packages/tailwind-config/tailwind.config.ts"), `NoExt resolved to unexpected path: ${noExtResolved}`);
  assert(tsExtResolved.endsWith("/packages/tailwind-config/tailwind.config.ts"), `TsExt resolved to unexpected path: ${tsExtResolved}`);
  assert(themesResolved.endsWith("/packages/tailwind-config/themes.css"), `Themes resolved to unexpected path: ${themesResolved}`);
  assert(fs.existsSync(fileURLToPath(themesResolved)), "themes.css must exist on disk");
});

check("PKG-02 (TypeScript Diagnostics): Typecheck import resolution in TS compiler", () => {
  // We invoke tsc with allowImportingTsExtensions via test runner
  const output = execSync("./apps/web/node_modules/.bin/tsc --project packages/ui/tsconfig.json --noEmit", {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert(!output.includes("error TS"), `TS diagnostics found errors in @dub/ui: ${output}`);
});

// -----------------------------------------------------------------------------
// 2. PKG-03: Hoisted pnpm.overrides & Zero Sub-package Overrides
// -----------------------------------------------------------------------------
check("PKG-03 (Monorepo Audit): Zero sub-package overrides and resolutions across repo", () => {
  const files = [];
  function scan(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".next", "build", "dist", ".turbo"].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(full);
      else if (ent.name === "package.json") files.push(full);
    }
  }
  scan(rootDir);

  for (const f of files) {
    const isRoot = path.resolve(f) === path.resolve(rootDir, "package.json");
    const json = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!isRoot) {
      assert(!json.pnpm?.overrides, `Sub-package ${path.relative(rootDir, f)} must not declare pnpm.overrides`);
      assert(!json.resolutions, `Sub-package ${path.relative(rootDir, f)} must not declare resolutions`);
    } else {
      assert(json.pnpm?.overrides, "Root package.json must declare pnpm.overrides");
      assert.strictEqual(json.pnpm.overrides["chrono-node"], "2.7.5");
      assert.strictEqual(json.pnpm.overrides["@types/react"], "19.1.14");
      assert.strictEqual(json.pnpm.overrides["@types/react-dom"], "19.1.9");
      assert(!json.resolutions, "Root package.json must not declare legacy resolutions");
    }
  }
});

check("PKG-03 (pnpm install warnings): pnpm install produces 0 sub-package overrides warnings", () => {
  const output = execSync("pnpm install", { cwd: rootDir, encoding: "utf8" });
  assert(!output.includes('The field "pnpm.overrides" was found in'), "pnpm install must not emit sub-package overrides warning");
  assert(!output.includes("WARN The field"), "pnpm install must not emit field warnings");
});

// -----------------------------------------------------------------------------
// 3. PKG-06: Email Template Default Brand Neutralization
// -----------------------------------------------------------------------------
check("PKG-06 (Source Audit): No Yamax brand references in points-expiry-reminder.tsx", () => {
  const templatePath = path.join(rootDir, "packages/email/src/templates/points-expiry-reminder.tsx");
  const content = fs.readFileSync(templatePath, "utf8");
  assert(content.includes('brandName = "Rewards Club"'), 'Template must default to "Rewards Club"');
  assert(!content.toLowerCase().includes("yamax"), 'Template must never mention "Yamax"');
});

check("PKG-06 (Vitest Execution): Run challenger brand neutralization test suite", () => {
  const testCmd = "pnpm --filter web test:unit tests/weletic/challenger-points-expiry-brand.test.tsx";
  const output = execSync(testCmd, { cwd: rootDir, encoding: "utf8" });
  assert(output.includes("14 passed"), `Expected 14 passed tests, got: ${output}`);
});

// -----------------------------------------------------------------------------
// 4. INFRA-04: Turborepo Build Cache Outputs & Cache Hits
// -----------------------------------------------------------------------------
check("INFRA-04 (Configuration): turbo.json outputs include build/**", () => {
  const turboJson = JSON.parse(fs.readFileSync(path.join(rootDir, "turbo.json"), "utf8"));
  assert(turboJson.pipeline?.build?.outputs?.includes("build/**"), "turbo.json must declare 'build/**' in build outputs");
});

check("INFRA-04 (Cache Hit & Restore Verification): Turbo caches and restores packages/shopify-app/build", () => {
  const buildDir = path.join(rootDir, "packages/shopify-app/build");
  
  // 1. Build and cache
  execSync("pnpm turbo build --filter=@weletic/shopify-app", { cwd: rootDir, encoding: "utf8" });
  assert(fs.existsSync(buildDir), "Build directory must exist after build");

  // 2. Remove build directory
  fs.rmSync(buildDir, { recursive: true, force: true });
  assert(!fs.existsSync(buildDir), "Build directory must be removed for test");

  // 3. Run again, must be FULL TURBO and recreate build directory
  const cachedOutput = execSync("pnpm turbo build --filter=@weletic/shopify-app", { cwd: rootDir, encoding: "utf8" });
  assert(cachedOutput.includes("FULL TURBO") || cachedOutput.includes("1 cached"), `Must hit Turbo cache: ${cachedOutput}`);
  assert(fs.existsSync(buildDir), "Build directory must be restored from cache");
  assert(fs.existsSync(path.join(buildDir, "server")), "Build server directory must be restored");
  assert(fs.existsSync(path.join(buildDir, "client")), "Build client directory must be restored");
});

console.log("\n================================================================================");
console.log(`TOTAL CHECKS: ${total}`);
console.log(`PASSED:       ${passed}`);
console.log(`FAILED:       ${total - passed}`);
console.log("================================================================================\n");

if (passed === total) {
  console.log("VERDICT: PASS (Challenger 1 Empirical Suite 100% Verified)\n");
} else {
  console.error("VERDICT: FAIL (Regressions or unmet criteria detected)\n");
  process.exit(1);
}
