import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  CHALLENGER M2_2: ADVERSARIAL PRIVILEGE ESCALATION & INVARIANT 4 VERIFICATION");
console.log("================================================================================\n");

let passed = 0;
let total = 0;
const failures = [];

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    failures.push({ name, error: err.message });
  }
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. Static Audit of Super-Admin Role Guards (getDubAdminRole & withAdmin)
  // ---------------------------------------------------------------------------
  console.log("--- 1. Adversarial Super-Admin Privilege Escalation Audit ---");

  const adminCodePath = path.join(rootDir, "apps/web/lib/auth/admin.ts");
  const adminCode = fs.readFileSync(adminCodePath, "utf8");

  await test("1.1: Guard against missing userId, null, or empty/whitespace DUB_WORKSPACE_ID", async () => {
    assert(
      adminCode.includes('if (!userId || !DUB_WORKSPACE_ID || DUB_WORKSPACE_ID.trim() === "")'),
      "admin.ts must guard against missing userId and empty/whitespace DUB_WORKSPACE_ID",
    );
    assert(adminCode.includes("return null;"), "Must return null when unconfigured or empty");
  });

  await test("1.2: Strict scoping of Prisma projectUsers query to DUB_WORKSPACE_ID", async () => {
    assert(
      adminCode.includes("userId_projectId: {\n        userId,\n        projectId: DUB_WORKSPACE_ID,\n      }"),
      "Prisma query must strictly pin projectId to DUB_WORKSPACE_ID",
    );
  });

  await test("1.3: withAdmin returns 401 when not admin and 403 on missing role", async () => {
    assert(adminCode.includes('return new Response("Unauthorized: Not an admin.", { status: 401 });'));
    assert(adminCode.includes("{ status: 403 }"));
  });

  // ---------------------------------------------------------------------------
  // 2. Static Audit of Dynamic Domain Registration
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Adversarial Dynamic Domain Registration Audit ---");

  const dynadotPath = path.join(rootDir, "apps/web/lib/dynadot/constants.ts");
  const dynadotCode = fs.readFileSync(dynadotPath, "utf8");

  await test("2.1: Wildcard '*' support in DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES", async () => {
    assert(
      dynadotCode.includes('list.includes("*")'),
      "isWorkspaceEligibleForDomainRegistration must support wildcard '*'",
    );
    assert(
      dynadotCode.includes('if (dynamicList.includes("*")) return true;'),
      "DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES proxy must support wildcard '*'",
    );
  });

  await test("2.2: Plan-based dynamic eligibility for paid plans", async () => {
    assert(
      dynadotCode.includes('workspace.plan && workspace.plan !== "free"'),
      "Must admit paid plans when workspace.plan !== 'free'",
    );
  });

  await test("2.3: Feature flag eligibility support", async () => {
    assert(
      dynadotCode.includes("workspace.flags?.domainRegistration"),
      "Must admit workspace when flags.domainRegistration is true",
    );
  });

  await test("2.4: Route usage audit: identify caller pattern in domains API routes", async () => {
    const registerRoutePath = path.join(rootDir, "apps/web/app/(ee)/api/domains/register/route.ts");
    const registerCode = fs.readFileSync(registerRoutePath, "utf8");
    assert(
      registerCode.includes("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(workspace.id)"),
      "register route calls DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(workspace.id)",
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Static Audit of Invariant 4 Zero-Hardcoding
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Adversarial Zero-Hardcoding Invariant 4 Static Grep ---");

  await test("3.1: Zero occurrences of 'montdev' in production runtime code", async () => {
    const stdout = execSync(
      'git grep -n "montdev" -- apps/web/lib apps/web/app apps/web/workers packages infra || true',
      { cwd: rootDir, encoding: "utf8" },
    );
    const matches = stdout.trim().split("\n").filter(Boolean);
    assert.deepStrictEqual(matches, [], `Found montdev in production code: ${matches.join(", ")}`);
  });

  await test("3.2: Zero occurrences of 'yamaxdev' in apps/web production runtime code", async () => {
    const stdout = execSync(
      'git grep -n "yamaxdev" -- apps/web/lib apps/web/app apps/web/workers packages || true',
      { cwd: rootDir, encoding: "utf8" },
    );
    const matches = stdout.trim().split("\n").filter(Boolean);
    assert.deepStrictEqual(matches, [], `Found yamaxdev in apps/web runtime code: ${matches.join(", ")}`);
  });

  await test("3.3: Zero occurrences of 'restricted-yamaxdev-testing' across monorepo code", async () => {
    const stdout = execSync(
      'git grep -n "restricted-yamaxdev-testing" -- apps/web packages infra || true',
      { cwd: rootDir, encoding: "utf8" },
    );
    const matches = stdout.trim().split("\n").filter(Boolean);
    assert.deepStrictEqual(matches, [], `Found restricted-yamaxdev-testing in code: ${matches.join(", ")}`);
  });

  await test("3.4: Upstream master constants in packages/utils/src/constants/main.ts use process.env", async () => {
    const constantsCode = fs.readFileSync(
      path.join(rootDir, "packages/utils/src/constants/main.ts"),
      "utf8",
    );
    assert(constantsCode.includes("process.env.DUB_WORKSPACE_ID ??"));
    assert(constantsCode.includes("process.env.ACME_WORKSPACE_ID ??"));
    assert(constantsCode.includes("process.env.ACME_PROGRAM_ID ??"));
    assert(constantsCode.includes("process.env.LEGAL_WORKSPACE_ID ??"));
    assert(constantsCode.includes("process.env.LEGAL_USER_ID ??"));
    assert(constantsCode.includes("process.env.NETWORK_WORKSPACE_ID ??"));
    assert(constantsCode.includes("process.env.NETWORK_PROGRAM_ID ??"));
    assert(constantsCode.includes("process.env.NETWORK_PROGRAM_SLUG ??"));
    assert(constantsCode.includes("process.env.NETWORK_PROGRAM_DEFAULT_GROUP_ID ??"));
    assert(constantsCode.includes("process.env.NETWORK_PROGRAM_DEFAULT_SALE_REWARD_ID ??"));
    assert(constantsCode.includes("process.env.NETWORK_USER_ID ??"));
  });

  // ---------------------------------------------------------------------------
  // 4. Automated Vitest Execution
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Vitest Automated Adversarial Test Execution ---");

  await test("4.1: Run challenger-m2-2-adversarial.test.ts (22 tests)", async () => {
    const output = execSync(
      "pnpm --filter web exec vitest run tests/weletic/challenger-m2-2-adversarial.test.ts",
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert(output.includes("22 passed"), "Expected all 22 tests to pass");
  });

  await test("4.2: Run milestone-2-tenant-isolation.test.ts (19 tests)", async () => {
    const output = execSync(
      "pnpm --filter web exec vitest run tests/weletic/milestone-2-tenant-isolation.test.ts",
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert(output.includes("19 passed"), "Expected all 19 tests to pass");
  });

  console.log("\n================================================================================");
  console.log(`  RESULTS: ${passed} / ${total} tests passed (${failures.length} failures)`);
  console.log("================================================================================\n");

  if (failures.length > 0) {
    console.error("FAILURES DETECTED IN ADVERSARIAL HARNESS!");
    process.exit(1);
  } else {
    console.log("VERDICT: ALL ADVERSARIAL HARNESS CHECKS PASSED EMPIRICALLY!");
  }
}

main().catch((err) => {
  console.error("FATAL ERROR IN HARNESS:", err);
  process.exit(1);
});
