import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockProjectUsersFindUnique = vi.fn();
const mockNotificationEmailFindMany = vi.fn();
const mockNotificationEmailCreate = vi.fn();
const mockNotificationEmailDeleteMany = vi.fn();
const mockCampaignFindFirst = vi.fn();
const mockGetSession = vi.fn();

vi.mock("@/lib/auth/utils", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    projectUsers: {
      findUnique: (...args: any[]) => mockProjectUsersFindUnique(...args),
    },
    notificationEmail: {
      findMany: (...args: any[]) => mockNotificationEmailFindMany(...args),
      create: (...args: any[]) => mockNotificationEmailCreate(...args),
      deleteMany: (...args: any[]) => mockNotificationEmailDeleteMany(...args),
    },
    campaign: {
      findFirst: (...args: any[]) => mockCampaignFindFirst(...args),
    },
  },
}));

import { getDubAdminRole, withAdmin } from "@/lib/auth/admin";
import {
  DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES,
  isWorkspaceEligibleForDomainRegistration,
} from "@/lib/dynadot/constants";
import { DUB_WORKSPACE_ID } from "@dub/utils";

function getRepoRootDir(): string {
  const current = process.cwd();
  if (current.endsWith("apps/web")) {
    return path.resolve(current, "../..");
  }
  return current;
}

describe("Challenger M2_2: Adversarial Role Escalation, Dynamic Domains & Invariant 4 Verification", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // 1. ADVERSARIAL PRIVILEGE ESCALATION: getDubAdminRole & withAdmin
  // =========================================================================
  describe("1. Adversarial Super-Admin Privilege Escalation (getDubAdminRole & withAdmin)", () => {
    it("1.1: returns null for empty string userId without querying database", async () => {
      const role = await getDubAdminRole("");
      expect(role).toBeNull();
      expect(mockProjectUsersFindUnique).not.toHaveBeenCalled();
    });

    it("1.2: returns null for null or undefined userId without querying database", async () => {
      const roleNull = await getDubAdminRole(null as unknown as string);
      const roleUndefined = await getDubAdminRole(
        undefined as unknown as string,
      );
      expect(roleNull).toBeNull();
      expect(roleUndefined).toBeNull();
      expect(mockProjectUsersFindUnique).not.toHaveBeenCalled();
    });

    it("1.3: returns null when userId is pure whitespace and DB has no such record", async () => {
      mockProjectUsersFindUnique.mockResolvedValueOnce(null);
      const role = await getDubAdminRole("   ");
      expect(role).toBeNull();
    });

    it("1.4: returns null for non-existent / unprivileged users", async () => {
      mockProjectUsersFindUnique.mockResolvedValueOnce(null);
      const role = await getDubAdminRole("usr_unprivileged_attacker");
      expect(role).toBeNull();
      expect(mockProjectUsersFindUnique).toHaveBeenCalledWith({
        where: {
          userId_projectId: {
            userId: "usr_unprivileged_attacker",
            projectId: DUB_WORKSPACE_ID,
          },
        },
        select: { role: true },
      });
    });

    it("1.5: returns null when user has role in another workspace but not in DUB_WORKSPACE_ID", async () => {
      // Prisma findUnique specifically queries { userId, projectId: DUB_WORKSPACE_ID }
      mockProjectUsersFindUnique.mockResolvedValueOnce(null);
      const role = await getDubAdminRole("victim_tenant_owner");
      expect(role).toBeNull();
    });

    it("1.6: grants role strictly when user is in DUB_WORKSPACE_ID record", async () => {
      mockProjectUsersFindUnique.mockResolvedValueOnce({ role: "owner" });
      const role = await getDubAdminRole("usr_legitimate_admin");
      expect(role).toBe("owner");
    });

    it("1.7: withAdmin returns 401 Unauthorized when getDubAdminRole returns null", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "unprivileged_user" },
      });
      mockProjectUsersFindUnique.mockResolvedValueOnce(null);

      const mockHandler = vi.fn().mockResolvedValue(new Response("OK"));
      const wrapped = withAdmin(mockHandler);

      const fakeReq = new Request("https://app.dub.co/api/admin/metrics");
      const fakeParams = Promise.resolve({});

      const response = await wrapped(fakeReq, { params: fakeParams });
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toContain("Unauthorized: Not an admin.");
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("1.8: withAdmin returns 403 Forbidden when adminRole does not meet requiredRoles", async () => {
      mockGetSession.mockResolvedValueOnce({ user: { id: "member_user" } });
      mockProjectUsersFindUnique.mockResolvedValueOnce({ role: "member" });

      const mockHandler = vi.fn().mockResolvedValue(new Response("OK"));
      const wrapped = withAdmin(mockHandler, {
        requiredRoles: ["owner"] as any,
      });

      const fakeReq = new Request("https://app.dub.co/api/admin/danger-zone");
      const fakeParams = Promise.resolve({});

      const response = await wrapped(fakeReq, { params: fakeParams });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain(
        "Unauthorized: Missing required admin role(s): owner.",
      );
      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. ADVERSARIAL DYNAMIC DOMAIN REGISTRATION ELIGIBILITY
  // =========================================================================
  describe("2. Adversarial Dynamic Domain Registration Eligibility", () => {
    it("2.1: wildcard '*' in DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES admits any workspace", () => {
      vi.stubEnv("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES", "*");

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_random_unprivileged_free",
          plan: "free",
        }),
      ).toBe(true);

      expect(
        DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(
          "ws_random_unprivileged_free",
        ),
      ).toBe(true);
    });

    it("2.2: wildcard '*' with whitespace padding 'ws_1, * , ws_2' admits any workspace", () => {
      vi.stubEnv("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES", "ws_1, * , ws_2");

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_arbitrary_tenant",
          plan: "free",
        }),
      ).toBe(true);

      expect(
        DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_arbitrary_tenant"),
      ).toBe(true);
    });

    it("2.3: admits paid tiers (pro, business, enterprise, custom_paid) dynamically", () => {
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_paid_1",
          plan: "pro",
        }),
      ).toBe(true);
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_paid_2",
          plan: "business",
        }),
      ).toBe(true);
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_paid_3",
          plan: "enterprise",
        }),
      ).toBe(true);
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_paid_4",
          plan: "growth",
        }),
      ).toBe(true);
    });

    it("2.4: strictly rejects free plan without feature flags or env whitelist", () => {
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_free_1",
          plan: "free",
        }),
      ).toBe(false);
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_free_2",
          plan: "free",
          flags: {},
        }),
      ).toBe(false);
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_free_3",
          plan: "free",
          flags: { otherFeature: true, domainRegistration: false },
        }),
      ).toBe(false);
    });

    it("2.5: admits free plan when domainRegistration flag is explicitly true", () => {
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_free_flagged",
          plan: "free",
          flags: { domainRegistration: true },
        }),
      ).toBe(true);
    });

    it("2.6: boundary cases: null, undefined, empty ID strictly return false", () => {
      expect(isWorkspaceEligibleForDomainRegistration(null as any)).toBe(false);
      expect(isWorkspaceEligibleForDomainRegistration(undefined as any)).toBe(
        false,
      );
      expect(isWorkspaceEligibleForDomainRegistration({ id: "" })).toBe(false);
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "",
          plan: "enterprise",
        }),
      ).toBe(false);
    });

    it("2.7: DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES proxy behaves seamlessly like an Array", () => {
      vi.stubEnv(
        "DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES",
        "ws_alpha, ws_beta, ws_gamma",
      );

      expect(Array.isArray(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES)).toBe(true);
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.length).toBe(3);
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES[0]).toBe("ws_alpha");
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES[1]).toBe("ws_beta");
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES[2]).toBe("ws_gamma");

      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_alpha")).toBe(
        true,
      );
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_beta")).toBe(
        true,
      );
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_delta")).toBe(
        false,
      );

      const mapped = DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.map(
        (id) => `prefix_${id}`,
      );
      expect(mapped).toEqual([
        "prefix_ws_alpha",
        "prefix_ws_beta",
        "prefix_ws_gamma",
      ]);
    });

    it("2.8: EMPIRICAL FINDING: DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(workspace.id) in routes does not check workspace.plan", () => {
      // In apps/web/app/(ee)/api/domains/register/route.ts:
      // Line 14: if (!DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(workspace.id))
      // Since it passes only workspace.id, the proxy cannot evaluate workspace.plan.
      // Therefore, isWorkspaceEligibleForDomainRegistration is TRUE for enterprise,
      // but DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes is FALSE unless wildcard * or env list is set.
      const paidWorkspace = {
        id: "ws_enterprise_tenant_999",
        plan: "enterprise",
      };

      expect(isWorkspaceEligibleForDomainRegistration(paidWorkspace)).toBe(
        true,
      );

      // Without wildcard env var, .includes(workspace.id) returns false:
      expect(
        DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(paidWorkspace.id),
      ).toBe(false);
    });
  });

  // =========================================================================
  // 3. ADVERSARIAL STATIC CODE GREP & INVARIANT 4 VERIFICATION
  // =========================================================================
  describe("3. Adversarial Zero-Hardcoding Static Grep (Invariant 4)", () => {
    const rootDir = getRepoRootDir();

    it("3.1: verifies ZERO occurrences of 'montdev' in production runtime code", () => {
      const searchDirs = [
        path.join(rootDir, "apps/web/lib"),
        path.join(rootDir, "apps/web/app"),
        path.join(rootDir, "apps/web/workers"),
        path.join(rootDir, "packages/contracts"),
        path.join(rootDir, "packages/shopify-app/app"),
        path.join(rootDir, "packages/utils/src"),
      ];

      const hits: string[] = [];

      function scan(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (
              ["node_modules", "dist", ".wrangler", ".turbo", ".next"].includes(
                entry.name,
              )
            )
              continue;
            scan(fullPath);
          } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, "utf8");
            if (content.includes("montdev")) {
              hits.push(fullPath.replace(rootDir, ""));
            }
          }
        }
      }

      for (const d of searchDirs) scan(d);
      expect(hits).toEqual([]);
    });

    it("3.2: verifies ZERO occurrences of 'yamaxdev' in apps/web production runtime code", () => {
      const searchDirs = [
        path.join(rootDir, "apps/web/lib"),
        path.join(rootDir, "apps/web/app"),
        path.join(rootDir, "apps/web/workers"),
        path.join(rootDir, "packages/contracts"),
        path.join(rootDir, "packages/shopify-app/app"),
        path.join(rootDir, "packages/utils/src"),
      ];

      const hits: string[] = [];

      function scan(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (
              ["node_modules", "dist", ".wrangler", ".turbo", ".next"].includes(
                entry.name,
              )
            )
              continue;
            scan(fullPath);
          } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, "utf8");
            if (content.includes("yamaxdev")) {
              hits.push(fullPath.replace(rootDir, ""));
            }
          }
        }
      }

      for (const d of searchDirs) scan(d);
      expect(hits).toEqual([]);
    });

    it("3.3: verifies ZERO occurrences of 'restricted-yamaxdev-testing' across monorepo code", () => {
      const searchDirs = [
        path.join(rootDir, "apps/web/lib"),
        path.join(rootDir, "apps/web/app"),
        path.join(rootDir, "packages"),
        path.join(rootDir, "infra"),
      ];

      const hits: string[] = [];

      function scan(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (
              ["node_modules", "dist", ".wrangler", ".turbo", ".next"].includes(
                entry.name,
              )
            )
              continue;
            scan(fullPath);
          } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, "utf8");
            if (content.includes("restricted-yamaxdev-testing")) {
              hits.push(fullPath.replace(rootDir, ""));
            }
          }
        }
      }

      for (const d of searchDirs) scan(d);
      expect(hits).toEqual([]);
    });

    it("3.4: verifies master constants in packages/utils/src/constants/main.ts use process.env lookups", () => {
      const constantsPath = path.join(
        rootDir,
        "packages/utils/src/constants/main.ts",
      );
      const code = fs.readFileSync(constantsPath, "utf8");

      expect(code).toContain("process.env.DUB_WORKSPACE_ID ??");
      expect(code).toContain("process.env.ACME_WORKSPACE_ID ??");
      expect(code).toContain("process.env.ACME_PROGRAM_ID ??");
      expect(code).toContain("process.env.LEGAL_WORKSPACE_ID ??");
      expect(code).toContain("process.env.NETWORK_WORKSPACE_ID ??");
      expect(code).toContain("process.env.NETWORK_PROGRAM_ID ??");
    });

    it("3.5: verifies E2E guard enforces 404 in production unless ENABLE_E2E_ROUTES is true", () => {
      const guardPath = path.join(
        rootDir,
        "apps/web/app/(ee)/api/e2e/guard.ts",
      );
      const code = fs.readFileSync(guardPath, "utf8");

      expect(code).toContain('process.env.NODE_ENV === "production"');
      expect(code).toContain('process.env.ENABLE_E2E_ROUTES !== "true"');
      expect(code).toContain('code: "not_found"');
    });

    it("3.6: verifies notification-emails route enforces workspace scoping on all CRUD operations", () => {
      const routePath = path.join(
        rootDir,
        "apps/web/app/(ee)/api/e2e/notification-emails/route.ts",
      );
      const code = fs.readFileSync(routePath, "utf8");

      expect(code).toContain("assertE2EWorkspace(workspace)");
      // GET scoped:
      expect(code).toContain("workspaceId: workspace.id");
      // POST scoped check:
      expect(code).toContain(
        "program: {\n            workspaceId: workspace.id,\n          }",
      );
      // DELETE scoped check:
      expect(code).toContain(
        "id: campaignId,\n        program: {\n          workspaceId: workspace.id,\n        }",
      );
    });
  });
});
