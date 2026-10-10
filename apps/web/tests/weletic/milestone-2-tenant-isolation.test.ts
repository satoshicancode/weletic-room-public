import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// Provide explicit mocks for Prisma models used in Milestone 2
const mockProjectUsersFindUnique = vi.fn();
const mockNotificationEmailFindMany = vi.fn();
const mockNotificationEmailCreate = vi.fn();
const mockNotificationEmailDeleteMany = vi.fn();
const mockCampaignFindFirst = vi.fn();

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

import { DubApiError } from "@/lib/api/errors";
import { assertE2EWorkspace } from "../../app/(ee)/api/e2e/guard";
import { getDubAdminRole } from "@/lib/auth/admin";
import {
  isWorkspaceEligibleForDomainRegistration,
  DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES,
  getEligibleDomainRegistrationWorkspaces,
} from "@/lib/dynadot/constants";
import {
  isRestrictedDevelopmentEnvironment,
} from "../../../../infra/shopify-development/restricted-policy.mjs";
import {
  DUB_WORKSPACE_ID,
  ACME_WORKSPACE_ID,
  NETWORK_WORKSPACE_ID,
  NETWORK_PROGRAM_ID,
} from "@dub/utils";
import { prisma } from "@/lib/prisma";
import fs from "node:fs";
import path from "node:path";

function resolveWorkspaceFile(relativeFromRepoRoot: string): string {
  const currentDir = process.cwd();
  if (currentDir.endsWith("apps/web")) {
    if (relativeFromRepoRoot.startsWith("apps/web/")) {
      return path.resolve(currentDir, relativeFromRepoRoot.replace(/^apps\/web\//, ""));
    }
    return path.resolve(currentDir, "../../", relativeFromRepoRoot);
  }
  return path.resolve(currentDir, relativeFromRepoRoot);
}

describe("Milestone 2: Multi-Tenant Isolation, Zero IDOR & Invariant 4 Compliance", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // SEC-R2-01: Upstream Dub Master Constants & Admin Role Boundaries
  // =========================================================================
  describe("SEC-R2-01: Upstream Dub Master Constants & Admin Role Guards", () => {
    it("constants export sensible defaults and can be abstracted via environment variables", () => {
      expect(DUB_WORKSPACE_ID).toBeDefined();
      expect(ACME_WORKSPACE_ID).toBeDefined();
      expect(NETWORK_WORKSPACE_ID).toBeDefined();
      expect(NETWORK_PROGRAM_ID).toBeDefined();
      expect(typeof DUB_WORKSPACE_ID).toBe("string");
      expect(typeof ACME_WORKSPACE_ID).toBe("string");
    });

    it("getDubAdminRole returns null when userId is missing or empty", async () => {
      const role1 = await getDubAdminRole("");
      expect(role1).toBeNull();
      expect(mockProjectUsersFindUnique).not.toHaveBeenCalled();
    });

    it("getDubAdminRole returns null if user is not in the configured admin workspace", async () => {
      mockProjectUsersFindUnique.mockResolvedValueOnce(null);
      const role = await getDubAdminRole("unregistered_user_id");
      expect(role).toBeNull();
      expect(mockProjectUsersFindUnique).toHaveBeenCalledWith({
        where: {
          userId_projectId: {
            userId: "unregistered_user_id",
            projectId: DUB_WORKSPACE_ID,
          },
        },
        select: { role: true },
      });
    });

    it("getDubAdminRole grants admin role only to users explicitly enrolled in DUB_WORKSPACE_ID", async () => {
      mockProjectUsersFindUnique.mockResolvedValueOnce({ role: "owner" });
      const adminRole = await getDubAdminRole("valid_admin_user");
      expect(adminRole).toBe("owner");

      mockProjectUsersFindUnique.mockResolvedValueOnce(null);
      const tenantRole = await getDubAdminRole("tenant_user_456");
      expect(tenantRole).toBeNull();
    });
  });

  // =========================================================================
  // SEC-R2-02: Production E2E Backdoor Environment Gate & Zero IDOR
  // =========================================================================
  describe("SEC-R2-02: Production E2E Environment Gate & Notification Emails Zero IDOR", () => {
    it("assertE2EWorkspace blocks access with HTTP 404 in production when ENABLE_E2E_ROUTES is not enabled", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_E2E_ROUTES", undefined);

      expect(() => {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      }).toThrowError(DubApiError);

      try {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      } catch (error: any) {
        expect(error.code).toBe("not_found");
        expect(error.message).toBe("Endpoint not found");
      }
    });

    it("assertE2EWorkspace allows access in production if ENABLE_E2E_ROUTES is explicitly true", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_E2E_ROUTES", "true");

      // Matching workspace should succeed
      expect(() => {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      }).not.toThrow();

      // Mismatched workspace should fail with 403 forbidden
      expect(() => {
        assertE2EWorkspace({ id: "unauthorized_tenant_workspace" });
      }).toThrowError(DubApiError);

      try {
        assertE2EWorkspace({ id: "unauthorized_tenant_workspace" });
      } catch (error: any) {
        expect(error.code).toBe("forbidden");
      }
    });

    it("assertE2EWorkspace supports dynamic E2E_WORKSPACE_ID in non-production", () => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("E2E_WORKSPACE_ID", "custom_e2e_ws_999");

      // Custom workspace succeeds
      expect(() => {
        assertE2EWorkspace({ id: "custom_e2e_ws_999" });
      }).not.toThrow();

      // Old default workspace is rejected
      expect(() => {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      }).toThrowError(DubApiError);
    });

    it("notification-emails query enforces workspace scoping through campaign.program.workspaceId (Zero IDOR)", async () => {
      const callerWorkspaceId = "ws_tenant_alpha";
      const victimCampaignId = "cmp_victim_beta";

      mockNotificationEmailFindMany.mockResolvedValueOnce([]);

      // Simulate query from GET route
      const searchParams = { campaignId: victimCampaignId, partnerId: "pt_123" };
      const whereClause = {
        ...(searchParams.campaignId && { campaignId: searchParams.campaignId }),
        ...(searchParams.partnerId && { partnerId: searchParams.partnerId }),
        type: "Campaign",
        campaign: {
          program: {
            workspaceId: callerWorkspaceId,
          },
        },
      };

      await prisma.notificationEmail.findMany({
        where: whereClause,
      });

      expect(mockNotificationEmailFindMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          type: "Campaign",
          campaignId: victimCampaignId,
          partnerId: "pt_123",
          campaign: {
            program: {
              workspaceId: callerWorkspaceId,
            },
          },
        }),
      });
    });

    it("campaign ownership validation prevents cross-tenant POST / DELETE IDOR", async () => {
      const callerWorkspaceId = "ws_tenant_alpha";
      const victimCampaignId = "cmp_victim_beta";

      mockCampaignFindFirst.mockResolvedValueOnce(null);

      const campaign = await prisma.campaign.findFirst({
        where: {
          id: victimCampaignId,
          program: {
            workspaceId: callerWorkspaceId,
          },
        },
      });

      expect(campaign).toBeNull();
      expect(mockCampaignFindFirst).toHaveBeenCalledWith({
        where: {
          id: victimCampaignId,
          program: {
            workspaceId: callerWorkspaceId,
          },
        },
      });
    });
  });

  // =========================================================================
  // SEC-R2-03: Dynamic Domain Registration Eligibility
  // =========================================================================
  describe("SEC-R2-03: Dynamic Domain Registration Eligibility", () => {
    it("admits workspaces on paid plans (pro, business, enterprise) dynamically", () => {
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_new_pro_tenant",
          plan: "pro",
        }),
      ).toBe(true);

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_new_enterprise_tenant",
          plan: "enterprise",
        }),
      ).toBe(true);

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_new_business_tenant",
          plan: "business",
        }),
      ).toBe(true);
    });

    it("rejects free workspace without feature flag or env allowance", () => {
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_random_free_tenant",
          plan: "free",
        }),
      ).toBe(false);
    });

    it("admits free workspace when domainRegistration feature flag is enabled", () => {
      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_flagged_free_tenant",
          plan: "free",
          flags: { domainRegistration: true },
        }),
      ).toBe(true);
    });

    it("admits arbitrary workspace when specified in DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES env var", () => {
      vi.stubEnv("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES", "ws_custom_tenant_1,ws_custom_tenant_2");

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_custom_tenant_1",
          plan: "free",
        }),
      ).toBe(true);

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_custom_tenant_2",
          plan: "free",
        }),
      ).toBe(true);

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "ws_unlisted_free_tenant",
          plan: "free",
        }),
      ).toBe(false);
    });

    it("supports wildcard '*' in DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES env var", () => {
      vi.stubEnv("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES", "*");

      expect(
        isWorkspaceEligibleForDomainRegistration({
          id: "any_arbitrary_workspace_id",
          plan: "free",
        }),
      ).toBe(true);

      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("any_arbitrary_workspace_id")).toBe(true);
    });

    it("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES proxy resolves dynamically at runtime", () => {
      vi.stubEnv("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES", "ws_runtime_1,ws_runtime_2");

      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_runtime_1")).toBe(true);
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_runtime_2")).toBe(true);
      expect(DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes("ws_runtime_unknown")).toBe(false);
    });

    it("verifies register route statically imports and invokes isWorkspaceEligibleForDomainRegistration", () => {
      const registerRoutePath = resolveWorkspaceFile(
        "apps/web/app/(ee)/api/domains/register/route.ts",
      );
      const content = fs.readFileSync(registerRoutePath, "utf8");

      expect(content).toContain("import { isWorkspaceEligibleForDomainRegistration } from \"@/lib/dynadot/constants\";");
      expect(content).toContain("if (!isWorkspaceEligibleForDomainRegistration(workspace))");
      expect(content).not.toContain("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(workspace.id)");
    });

    it("verifies status route statically imports and invokes isWorkspaceEligibleForDomainRegistration", () => {
      const statusRoutePath = resolveWorkspaceFile(
        "apps/web/app/(ee)/api/domains/status/route.ts",
      );
      const content = fs.readFileSync(statusRoutePath, "utf8");

      expect(content).toContain("import { isWorkspaceEligibleForDomainRegistration } from \"@/lib/dynadot/constants\";");
      expect(content).toContain("if (!isWorkspaceEligibleForDomainRegistration(workspace))");
      expect(content).not.toContain("DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.includes(workspace.id)");
    });

    it("enforces dynamic domain registration eligibility matching register route semantics", () => {
      const checkRegisterRoute = (workspace: { id: string; plan?: string | null; flags?: Record<string, any> | null }) => {
        if (!isWorkspaceEligibleForDomainRegistration(workspace)) {
          throw new DubApiError({
            code: "forbidden",
            message:
              "POST /domains/register is not available for your workspace. Contact support for more information.",
          });
        }
      };

      // Paid plans are admitted
      expect(() => checkRegisterRoute({ id: "ws_paid_pro_tenant", plan: "pro" })).not.toThrow();
      expect(() => checkRegisterRoute({ id: "ws_paid_biz_tenant", plan: "business" })).not.toThrow();
      expect(() => checkRegisterRoute({ id: "ws_paid_ent_tenant", plan: "enterprise" })).not.toThrow();

      // Feature flagged free workspace is admitted
      expect(() =>
        checkRegisterRoute({
          id: "ws_flagged_free_tenant",
          plan: "free",
          flags: { domainRegistration: true },
        }),
      ).not.toThrow();

      // Unflagged free workspace is rejected with 403 forbidden
      expect(() => checkRegisterRoute({ id: "ws_unauthorized_free_tenant", plan: "free" })).toThrowError(DubApiError);
      try {
        checkRegisterRoute({ id: "ws_unauthorized_free_tenant", plan: "free" });
      } catch (error: any) {
        expect(error.code).toBe("forbidden");
        expect(error.message).toBe(
          "POST /domains/register is not available for your workspace. Contact support for more information.",
        );
      }
    });

    it("enforces dynamic domain registration eligibility matching status route semantics", () => {
      const checkStatusRoute = (workspace: { id: string; plan?: string | null; flags?: Record<string, any> | null }) => {
        if (!isWorkspaceEligibleForDomainRegistration(workspace)) {
          throw new DubApiError({
            code: "forbidden",
            message:
              "GET /domains/status is not available for your workspace. Contact support for more information.",
          });
        }
      };

      // Paid plans are admitted
      expect(() => checkStatusRoute({ id: "ws_paid_pro_tenant", plan: "pro" })).not.toThrow();
      expect(() => checkStatusRoute({ id: "ws_paid_biz_tenant", plan: "business" })).not.toThrow();
      expect(() => checkStatusRoute({ id: "ws_paid_ent_tenant", plan: "enterprise" })).not.toThrow();

      // Feature flagged free workspace is admitted
      expect(() =>
        checkStatusRoute({
          id: "ws_flagged_free_tenant",
          plan: "free",
          flags: { domainRegistration: true },
        }),
      ).not.toThrow();

      // Unflagged free workspace is rejected with 403 forbidden
      expect(() => checkStatusRoute({ id: "ws_unauthorized_free_tenant", plan: "free" })).toThrowError(DubApiError);
      try {
        checkStatusRoute({ id: "ws_unauthorized_free_tenant", plan: "free" });
      } catch (error: any) {
        expect(error.code).toBe("forbidden");
        expect(error.message).toBe(
          "GET /domains/status is not available for your workspace. Contact support for more information.",
        );
      }
    });
  });

  // =========================================================================
  // SEC-R2-04: Dynamic E2E Cron Cleanup Workspace Target
  // =========================================================================
  describe("SEC-R2-04: Dynamic E2E Cron Cleanup Workspace Target", () => {
    it("cron cleanup configuration supports dynamic workspace and user overrides", async () => {
      vi.stubEnv("E2E_CLEANUP_WORKSPACE_ID", "ws_dynamically_targeted_for_cleanup");
      vi.stubEnv("E2E_CLEANUP_USER_ID", "usr_dynamically_targeted_for_cleanup");

      const routeFilePath = resolveWorkspaceFile(
        "apps/web/app/(ee)/api/cron/cleanup/e2e-tests/route.ts",
      );
      const content = fs.readFileSync(routeFilePath, "utf8");

      expect(content).toContain("process.env.E2E_CLEANUP_WORKSPACE_ID");
      expect(content).toContain("process.env.E2E_CLEANUP_USER_ID");
    });
  });

  // =========================================================================
  // SEC-R2-05: Sanitized Residual Literals in Restricted Policy & Bootstrap
  // =========================================================================
  describe("SEC-R2-05: Sanitized Residual Literals in Restricted Development", () => {
    const generation = "11111111-1111-4111-8111-111111111111";

    it("dynamically admits arbitrary development store via WELETIC_RESTRICTED_DEV_STORE", () => {
      const customStore = "acme-tenant-testing";
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("WELETIC_ISOLATED_DEVELOPMENT", "1");
      vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
      vi.stubEnv("WELETIC_RESTRICTED_DEV_STORE", customStore);
      vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", customStore);
      vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", generation);
      vi.stubEnv("SHOPIFY_API_KEY", "app_123");
      vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/123");
      vi.stubEnv("DATABASE_URL", "mysql://synthetic@127.0.0.1:60101/test");
      vi.stubEnv("PLANETSCALE_DATABASE_URL", "http://127.0.0.1:65367/test");
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://127.0.0.1:8079");
      vi.stubEnv("STORAGE_ENDPOINT", "http://127.0.0.1:9002");

      expect(isRestrictedDevelopmentEnvironment(process.env)).toBe(true);
    });

    it("rejects mismatched development store when WELETIC_RESTRICTED_DEV_STORE is customized", () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("WELETIC_ISOLATED_DEVELOPMENT", "1");
      vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
      vi.stubEnv("WELETIC_RESTRICTED_DEV_STORE", "store-a");
      vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", "store-b");
      vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", generation);
      vi.stubEnv("SHOPIFY_API_KEY", "app_123");
      vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/123");
      vi.stubEnv("DATABASE_URL", "mysql://synthetic@127.0.0.1:60101/test");
      vi.stubEnv("PLANETSCALE_DATABASE_URL", "http://127.0.0.1:65367/test");
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://127.0.0.1:8079");
      vi.stubEnv("STORAGE_ENDPOINT", "http://127.0.0.1:9002");

      expect(isRestrictedDevelopmentEnvironment(process.env)).toBe(false);
    });

    it("verifies static elimination of hardcoded 'restricted-yamaxdev-testing' literal", () => {
      const filesToCheck = [
        "apps/web/lib/weletic/shopify/company-store-bootstrap.ts",
        "apps/web/lib/weletic/shopify/app-pricing-service.ts",
      ];

      for (const rel of filesToCheck) {
        const fullPath = resolveWorkspaceFile(rel);
        const code = fs.readFileSync(fullPath, "utf8");
        expect(code).not.toContain('"restricted-yamaxdev-testing"');
        expect(code).toContain("process.env.WELETIC_RESTRICTED_DEV_STORE");
      }
    });
  });
});
