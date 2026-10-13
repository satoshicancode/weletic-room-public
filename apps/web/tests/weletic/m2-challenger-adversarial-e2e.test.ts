import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock Next.js 15 'after' to allow handleApiError testing outside request lifecycle
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    after: vi.fn(),
  };
});

// Mocks for Prisma models
const mockNotificationEmailFindMany = vi.fn();
const mockNotificationEmailCreate = vi.fn();
const mockNotificationEmailDeleteMany = vi.fn();
const mockCampaignFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
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

// Mock withWorkspace to allow direct execution of route handlers
vi.mock("@/lib/auth", () => ({
  withWorkspace: (handler: any, options: any) => {
    const wrapped = (ctx: any) => handler(ctx);
    wrapped.options = options;
    return wrapped;
  },
}));

import { ErrorCodes } from "@/lib/api/error-codes";
import { DubApiError, handleApiError } from "@/lib/api/errors";
import { ACME_PROGRAM_ID, ACME_WORKSPACE_ID } from "@dub/utils";
import fs from "node:fs";
import path from "node:path";
import { assertE2EWorkspace } from "../../app/(ee)/api/e2e/guard";
import {
  DELETE as notificationEmailsDELETE,
  GET as notificationEmailsGET,
  POST as notificationEmailsPOST,
} from "../../app/(ee)/api/e2e/notification-emails/route";

describe("Adversarial E2E Backdoor & Cross-Tenant IDOR Challenger (Milestone 2)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // SUITE 1: Adversarial E2E Environment Gate (assertE2EWorkspace)
  // =========================================================================
  describe("Adversarial Challenge: E2E Environment Gate & Production Backdoor Prevention", () => {
    it("Strictly blocks access with HTTP 404 in production when ENABLE_E2E_ROUTES is unset", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_E2E_ROUTES", undefined);

      let thrownError: any = null;
      try {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(DubApiError);
      expect(thrownError.code).toBe("not_found");
      expect(thrownError.message).toBe("Endpoint not found");
      expect(ErrorCodes[thrownError.code as keyof typeof ErrorCodes]).toBe(404);

      // Verify handleApiError translates DubApiError('not_found') to HTTP 404
      const apiErrorResponse = handleApiError({ error: thrownError });
      expect(apiErrorResponse.status).toBe(404);
      expect(apiErrorResponse.error.code).toBe("not_found");
    });

    it("Falsy & bypass payloads for ENABLE_E2E_ROUTES fail closed with 404 in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      const adversarialEnvPayloads = [
        "",
        "false",
        "0",
        "null",
        "undefined",
        "no",
        "TRUE", // strict case-sensitive check ensures only exact "true" is accepted
        "1",
        " true ",
      ];

      for (const payload of adversarialEnvPayloads) {
        vi.stubEnv("ENABLE_E2E_ROUTES", payload);

        expect(() => {
          assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
        }).toThrowError(DubApiError);

        try {
          assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
        } catch (err: any) {
          expect(err.code).toBe("not_found");
          const { status } = handleApiError({ error: err });
          expect(status).toBe(404);
        }
      }
    });

    it("Allows access in production ONLY when ENABLE_E2E_ROUTES is exact string 'true' AND workspace matches", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_E2E_ROUTES", "true");

      // Valid Acme workspace passes
      expect(() => {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      }).not.toThrow();

      // Unauthorized tenant workspace is strictly blocked with 403 Forbidden
      expect(() => {
        assertE2EWorkspace({ id: "ws_rogue_tenant_999" });
      }).toThrowError(DubApiError);

      try {
        assertE2EWorkspace({ id: "ws_rogue_tenant_999" });
      } catch (err: any) {
        expect(err.code).toBe("forbidden");
        const { status } = handleApiError({ error: err });
        expect(status).toBe(403);
      }
    });

    it("Supports dynamic E2E_WORKSPACE_ID in production when explicitly enabled", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_E2E_ROUTES", "true");
      vi.stubEnv("E2E_WORKSPACE_ID", "ws_dedicated_staging_e2e");

      // Custom workspace passes
      expect(() => {
        assertE2EWorkspace({ id: "ws_dedicated_staging_e2e" });
      }).not.toThrow();

      // Default Acme workspace is now rejected because E2E_WORKSPACE_ID was overridden
      expect(() => {
        assertE2EWorkspace({ id: ACME_WORKSPACE_ID });
      }).toThrowError(DubApiError);
    });

    it("Rejects non-matching workspace in non-production environments with 403 Forbidden", () => {
      vi.stubEnv("NODE_ENV", "development");

      expect(() => {
        assertE2EWorkspace({ id: "ws_unauthorized_dev_tenant" });
      }).toThrowError(DubApiError);

      try {
        assertE2EWorkspace({ id: "ws_unauthorized_dev_tenant" });
      } catch (err: any) {
        expect(err.code).toBe("forbidden");
        const { status } = handleApiError({ error: err });
        expect(status).toBe(403);
      }
    });
  });

  // =========================================================================
  // SUITE 2: Cross-Tenant Gating: Non-E2E Tenant Calling E2E Routes
  // =========================================================================
  describe("Adversarial Challenge: Non-E2E Tenant Blocked at Gate", () => {
    const rogueTenantWorkspace = {
      id: "ws_rogue_tenant_xyz",
      defaultProgramId: "prog_rogue_xyz",
    };

    it("GET: Rejects unauthorized tenant with 403 Forbidden before reaching database", async () => {
      vi.stubEnv("NODE_ENV", "test");

      await expect(
        (notificationEmailsGET as any)({
          workspace: rogueTenantWorkspace,
          searchParams: { campaignId: "cmp_target_campaign" },
        }),
      ).rejects.toThrowError(DubApiError);

      expect(mockNotificationEmailFindMany).not.toHaveBeenCalled();
    });

    it("POST: Rejects unauthorized tenant with 403 Forbidden before reaching database", async () => {
      vi.stubEnv("NODE_ENV", "test");

      const req = new NextRequest(
        "http://localhost/api/e2e/notification-emails",
        {
          method: "POST",
          body: JSON.stringify({ campaignId: "cmp_target_campaign" }),
        },
      );

      await expect(
        (notificationEmailsPOST as any)({
          req,
          workspace: rogueTenantWorkspace,
        }),
      ).rejects.toThrowError(DubApiError);

      expect(mockCampaignFindFirst).not.toHaveBeenCalled();
      expect(mockNotificationEmailCreate).not.toHaveBeenCalled();
    });

    it("DELETE: Rejects unauthorized tenant with 403 Forbidden before reaching database", async () => {
      vi.stubEnv("NODE_ENV", "test");

      await expect(
        (notificationEmailsDELETE as any)({
          workspace: rogueTenantWorkspace,
          searchParams: { campaignId: "cmp_target_campaign" },
        }),
      ).rejects.toThrowError(DubApiError);

      expect(mockCampaignFindFirst).not.toHaveBeenCalled();
      expect(mockNotificationEmailDeleteMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SUITE 3: Cross-Tenant IDOR: Authorized Caller Targeting Other Tenant Resources
  // =========================================================================
  describe("Adversarial Challenge: Cross-Tenant IDOR Isolation on Resources", () => {
    // Caller is authorized for E2E routes (Acme test workspace)
    const callerWorkspace = {
      id: ACME_WORKSPACE_ID,
      defaultProgramId: ACME_PROGRAM_ID,
    };

    const victimCampaignId = "cmp_victim_external_workspace_b";
    const ownCampaignId = "cmp_acme_internal_campaign_a";

    // -----------------------------------------------------------------------
    // GET Route IDOR Tests
    // -----------------------------------------------------------------------
    it("GET: Prevents cross-tenant email leakage when caller queries a foreign campaignId", async () => {
      vi.stubEnv("NODE_ENV", "test");

      // In the database, the foreign campaign belongs to another workspace,
      // so relational filter campaign.program.workspaceId = callerWorkspace.id yields empty
      mockNotificationEmailFindMany.mockResolvedValueOnce([]);

      const response = await (notificationEmailsGET as any)({
        workspace: callerWorkspace,
        searchParams: { campaignId: victimCampaignId },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual([]);

      // Verify query is strictly bound to caller's workspaceId
      expect(mockNotificationEmailFindMany).toHaveBeenCalledWith({
        where: {
          campaignId: victimCampaignId,
          type: "Campaign",
          campaign: {
            program: {
              workspaceId: callerWorkspace.id,
            },
          },
        },
      });
    });

    it("GET: Prevents cross-tenant email leakage when caller queries by partnerId", async () => {
      vi.stubEnv("NODE_ENV", "test");

      mockNotificationEmailFindMany.mockResolvedValueOnce([]);

      const response = await (notificationEmailsGET as any)({
        workspace: callerWorkspace,
        searchParams: { partnerId: "pt_shared_across_tenants" },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual([]);

      // Verifies workspace scoping is enforced even without campaignId
      expect(mockNotificationEmailFindMany).toHaveBeenCalledWith({
        where: {
          partnerId: "pt_shared_across_tenants",
          type: "Campaign",
          campaign: {
            program: {
              workspaceId: callerWorkspace.id,
            },
          },
        },
      });
    });

    // -----------------------------------------------------------------------
    // POST Route IDOR Tests
    // -----------------------------------------------------------------------
    it("POST: Strictly blocks email creation on a foreign/victim campaign with HTTP 404", async () => {
      vi.stubEnv("NODE_ENV", "test");

      // Campaign query fails to find foreign campaign within caller workspace
      mockCampaignFindFirst.mockResolvedValueOnce(null);

      const req = new NextRequest(
        "http://localhost/api/e2e/notification-emails",
        {
          method: "POST",
          body: JSON.stringify({
            campaignId: victimCampaignId,
            emailId: "evil_email_injection_01",
            partnerId: "pt_foreign_partner",
          }),
        },
      );

      const response = await (notificationEmailsPOST as any)({
        req,
        workspace: callerWorkspace,
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Campaign not found in workspace" });

      // Verify campaign ownership was checked against caller workspace
      expect(mockCampaignFindFirst).toHaveBeenCalledWith({
        where: {
          id: victimCampaignId,
          program: {
            workspaceId: callerWorkspace.id,
          },
        },
      });

      // Crucial: notificationEmail.create must NEVER be invoked on unauthorized campaign
      expect(mockNotificationEmailCreate).not.toHaveBeenCalled();
    });

    it("POST: Allows email creation when campaign belongs to caller workspace", async () => {
      vi.stubEnv("NODE_ENV", "test");

      mockCampaignFindFirst.mockResolvedValueOnce({
        id: ownCampaignId,
        programId: callerWorkspace.defaultProgramId,
      });

      mockNotificationEmailCreate.mockResolvedValueOnce({
        id: "em_created_123",
        emailId: "legit_email_01",
        campaignId: ownCampaignId,
        programId: callerWorkspace.defaultProgramId,
      });

      const req = new NextRequest(
        "http://localhost/api/e2e/notification-emails",
        {
          method: "POST",
          body: JSON.stringify({
            campaignId: ownCampaignId,
            emailId: "legit_email_01",
          }),
        },
      );

      const response = await (notificationEmailsPOST as any)({
        req,
        workspace: callerWorkspace,
      });

      expect(response.status).toBe(200);
      expect(mockNotificationEmailCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          campaignId: ownCampaignId,
          programId: callerWorkspace.defaultProgramId,
          emailId: "legit_email_01",
          type: "Campaign",
        }),
      });
    });

    // -----------------------------------------------------------------------
    // DELETE Route IDOR Tests
    // -----------------------------------------------------------------------
    it("DELETE: Strictly blocks cross-tenant email deletion on foreign campaign with HTTP 404", async () => {
      vi.stubEnv("NODE_ENV", "test");

      // Victim campaign does not exist in caller workspace
      mockCampaignFindFirst.mockResolvedValueOnce(null);

      const response = await (notificationEmailsDELETE as any)({
        workspace: callerWorkspace,
        searchParams: { campaignId: victimCampaignId },
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Campaign not found in workspace" });

      // Verify campaign ownership was checked
      expect(mockCampaignFindFirst).toHaveBeenCalledWith({
        where: {
          id: victimCampaignId,
          program: {
            workspaceId: callerWorkspace.id,
          },
        },
      });

      // Crucial: deleteMany must NEVER be executed on victim campaign
      expect(mockNotificationEmailDeleteMany).not.toHaveBeenCalled();
    });

    it("DELETE: Returns HTTP 400 when campaignId is missing from deletion request", async () => {
      vi.stubEnv("NODE_ENV", "test");

      const response = await (notificationEmailsDELETE as any)({
        workspace: callerWorkspace,
        searchParams: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: "campaignId is required" });
      expect(mockNotificationEmailDeleteMany).not.toHaveBeenCalled();
    });

    it("DELETE: Allows deletion when campaign belongs to caller workspace", async () => {
      vi.stubEnv("NODE_ENV", "test");

      mockCampaignFindFirst.mockResolvedValueOnce({
        id: ownCampaignId,
        programId: callerWorkspace.defaultProgramId,
      });

      mockNotificationEmailDeleteMany.mockResolvedValueOnce({ count: 4 });

      const response = await (notificationEmailsDELETE as any)({
        workspace: callerWorkspace,
        searchParams: { campaignId: ownCampaignId },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ deleted: 4 });
      expect(mockNotificationEmailDeleteMany).toHaveBeenCalledWith({
        where: {
          campaignId: ownCampaignId,
          type: "Campaign",
        },
      });
    });
  });

  // =========================================================================
  // SUITE 4: Comprehensive Gate Interception on notification-emails Routes in Production
  // =========================================================================
  describe("Adversarial Challenge: Route Level Gate Interception in Production", () => {
    it("GET, POST, and DELETE routes throw 404 not_found before any DB access when ENABLE_E2E_ROUTES is unset in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_E2E_ROUTES", undefined);

      const ws = { id: ACME_WORKSPACE_ID, defaultProgramId: ACME_PROGRAM_ID };

      // GET attempt in production
      await expect(
        (notificationEmailsGET as any)({
          workspace: ws,
          searchParams: { campaignId: "cmp_any" },
        }),
      ).rejects.toThrowError(DubApiError);

      // POST attempt in production
      const postReq = new NextRequest(
        "http://localhost/api/e2e/notification-emails",
        {
          method: "POST",
          body: JSON.stringify({ campaignId: "cmp_any" }),
        },
      );
      await expect(
        (notificationEmailsPOST as any)({
          req: postReq,
          workspace: ws,
        }),
      ).rejects.toThrowError(DubApiError);

      // DELETE attempt in production
      await expect(
        (notificationEmailsDELETE as any)({
          workspace: ws,
          searchParams: { campaignId: "cmp_any" },
        }),
      ).rejects.toThrowError(DubApiError);

      // Verify zero DB calls were made across all three attempts
      expect(mockNotificationEmailFindMany).not.toHaveBeenCalled();
      expect(mockCampaignFindFirst).not.toHaveBeenCalled();
      expect(mockNotificationEmailCreate).not.toHaveBeenCalled();
      expect(mockNotificationEmailDeleteMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SUITE 5: Static Audit of All E2E Endpoints for Guard Inclusion
  // =========================================================================
  describe("Static Audit: All E2E Endpoints Must Enforce assertE2EWorkspace", () => {
    it("verifies every route file in app/(ee)/api/e2e imports and invokes assertE2EWorkspace", () => {
      const e2eBaseDir = path.resolve(
        process.cwd(),
        process.cwd().endsWith("apps/web")
          ? "app/(ee)/api/e2e"
          : "apps/web/app/(ee)/api/e2e",
      );

      const scanDirectory = (dir: string): string[] => {
        let results: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            results = results.concat(scanDirectory(fullPath));
          } else if (entry.name === "route.ts") {
            results.push(fullPath);
          }
        }
        return results;
      };

      const routeFiles = scanDirectory(e2eBaseDir);
      expect(routeFiles.length).toBeGreaterThan(0);

      for (const routeFile of routeFiles) {
        const content = fs.readFileSync(routeFile, "utf8");
        const relativeName = path.relative(e2eBaseDir, routeFile);

        expect(
          content,
          `Route file ${relativeName} must import assertE2EWorkspace`,
        ).toContain("assertE2EWorkspace");

        expect(
          content,
          `Route file ${relativeName} must invoke assertE2EWorkspace(workspace)`,
        ).toMatch(/assertE2EWorkspace\(\s*workspace\s*\)/);
      }
    });
  });
});
