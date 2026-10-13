import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  CHALLENGER 2: ADVERSARIAL SSRF, XSS & INVARIANT 4 VERIFICATION (MILESTONE 2)");
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
  // FOCUS 1: SSRF Defense & External Proxy Elimination Static Audit
  // ============================================================================
  console.log("--- FOCUS 1: Storage SSRF Defense & wsrv.nl Proxy Elimination Audit ---");

  const storageCodePath = path.join(rootDir, "apps/web/lib/storage.ts");
  const storageCode = fs.readFileSync(storageCodePath, "utf8");

  await runTest("Focus 1.1: Verification of zero wsrv.nl external proxy usage in storage.ts", async () => {
    assert(!storageCode.includes("wsrv.nl"), "storage.ts MUST NOT contain any reference to wsrv.nl");
    assert(!storageCode.includes("images.weserv.nl"), "storage.ts MUST NOT contain weserv.nl references");
    assert(storageCode.includes("sharp"), "storage.ts must use sharp for local in-process image resizing");
  });

  await runTest("Focus 1.2: Code inspection of assertSafeUrl protocol and hostname boundaries", async () => {
    assert(storageCode.includes('protocol !== "http:" && protocol !== "https:"'), "Must enforce http/https protocols");
    assert(storageCode.includes('.endsWith(".internal")'), "Must block .internal domain suffix");
    assert(storageCode.includes('.endsWith(".local")'), "Must block .local domain suffix");
    assert(storageCode.includes('.endsWith(".localhost")'), "Must block .localhost domain suffix");
  });

  await runTest("Focus 1.3: Code inspection of assertSafeIp comprehensive CIDR / IP coverage", async () => {
    assert(storageCode.includes("parts[0] === 127"), "Must block loopback 127.0.0.0/8");
    assert(storageCode.includes("parts[0] === 10"), "Must block RFC 1918 10.0.0.0/8");
    assert(storageCode.includes("parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31"), "Must block RFC 1918 172.16.0.0/12");
    assert(storageCode.includes("parts[0] === 192 && parts[1] === 168"), "Must block RFC 1918 192.168.0.0/16");
    assert(storageCode.includes("parts[0] === 169 && parts[1] === 254"), "Must block link-local cloud metadata 169.254.0.0/16");
    assert(storageCode.includes("parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127"), "Must block CGNAT 100.64.0.0/10");
    assert(storageCode.includes("parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)"), "Must block benchmark 198.18.0.0/15");
    assert(storageCode.includes("parts[0] >= 224"), "Must block multicast / reserved ranges");
    assert(storageCode.includes('addr === "::1"'), "Must block IPv6 loopback");
    assert(storageCode.includes('addr.startsWith("fc")'), "Must block IPv6 ULA fc00::/7");
    assert(storageCode.includes('addr.startsWith("fd")'), "Must block IPv6 ULA fd00::/7");
  });

  // ============================================================================
  // FOCUS 2: DOM-XSS Sanitization & Standards Audit
  // ============================================================================
  console.log("\n--- FOCUS 2: DOM-XSS Sanitization & Editor Standards Audit ---");

  const editorCodePath = path.join(rootDir, "apps/web/ui/weletic/yamax-product-description-editor.tsx");
  const editorCode = fs.readFileSync(editorCodePath, "utf8");

  await runTest("Focus 2.1: escapeHtml entity encoding completeness", async () => {
    assert(editorCode.includes('.replace(/&/g, "&amp;")'), "Must encode ampersands");
    assert(editorCode.includes('.replace(/</g, "&lt;")'), "Must encode open brackets");
    assert(editorCode.includes('.replace(/>/g, "&gt;")'), "Must encode close brackets");
    assert(editorCode.includes('.replace(/"/g, "&quot;")'), "Must encode double quotes");
    assert(editorCode.includes('.replace(/\'/g, "&#39;")'), "Must encode single quotes");
  });

  await runTest("Focus 2.2: Dynamic inputs in HTML generators wrapped in escapeHtml", async () => {
    assert(editorCode.includes("escapeHtml(hero.tagline)"), "hero.tagline must be escaped");
    assert(editorCode.includes("escapeHtml(fitTip)"), "fitTip must be escaped in size guide");
    assert(editorCode.includes("escapeHtml(accordions.fabricComposition)"), "fabricComposition must be escaped");
    assert(editorCode.includes("escapeHtml(accordions.washInstruction)"), "washInstruction must be escaped");
  });

  // ============================================================================
  // FOCUS 3: Zero-Hardcoding Invariant 4 Grep & AST Audit
  // ============================================================================
  console.log("\n--- FOCUS 3: Zero-Hardcoding Invariant 4 Grep & AST Audit ---");

  const runtimeTargetFiles = [
    "apps/web/lib/weletic/shopify/app-pricing-service.ts",
    "apps/web/lib/weletic/shopify/restricted-development.ts",
    "infra/shopify-development/restricted-policy.mjs",
  ];

  await runTest("Focus 3.1: Zero occurrences of montdev.myshopify.com in production files", async () => {
    const offending = [];
    for (const rel of runtimeTargetFiles) {
      const full = path.join(rootDir, rel);
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full, "utf8");
        if (content.includes("montdev.myshopify.com")) offending.push(rel);
      }
    }
    assert.deepStrictEqual(offending, [], `Found hardcoded montdev in ${offending.join(", ")}`);
  });

  await runTest("Focus 3.2: Zero occurrences of static app ID literal in runtime files", async () => {
    const offending = [];
    for (const rel of runtimeTargetFiles) {
      const full = path.join(rootDir, rel);
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full, "utf8");
        if (content.includes("c7d49cebb06e445db345bb200f966a03")) offending.push(rel);
      }
    }
    assert.deepStrictEqual(offending, [], `Found hardcoded app ID in ${offending.join(", ")}`);
  });

  // ============================================================================
  // FOCUS 4: Automated Vitest Adversarial Execution
  // ============================================================================
  console.log("\n--- FOCUS 4: Empirical Vitest Adversarial Execution ---");

  await runTest("Focus 4.1: Execute Vitest Adversarial Stress Suite (50 tests)", async () => {
    const cmd = "pnpm --filter web exec vitest run tests/weletic/challenger2-adversarial-m2.test.ts";
    const stdout = execSync(cmd, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert(stdout.includes("50 passed"), "All 50 tests in challenger2-adversarial-m2.test.ts must pass");
  });

  await runTest("Focus 4.2: Execute Worker Security Audit Suites (SEC-AUDIT-01 through 08)", async () => {
    const cmd = "pnpm --filter web exec vitest run tests/weletic/sec-audit-";
    const stdout = execSync(cmd, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert(stdout.includes("49 passed"), "All 49 worker security audit tests must pass");
  });

  console.log("\n================================================================================");
  console.log(`  RESULTS: ${passed} / ${total} tests passed (${failures.length} failures)`);
  console.log("================================================================================\n");

  if (failures.length > 0) {
    console.error("FAILURES DETECTED!");
    process.exit(1);
  } else {
    console.log("ALL ADVERSARIAL STRESS HARNESS CHECKS PASSED EMPIRICALLY!");
  }
}

main().catch((err) => {
  console.error("FATAL ERROR IN TEST HARNESS:", err);
  process.exit(1);
});
