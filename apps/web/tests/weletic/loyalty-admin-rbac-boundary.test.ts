import { getPermissionsByRole } from "@/lib/api/rbac/permissions";
import { RESOURCE_KEYS, RESOURCES } from "@/lib/api/rbac/resources";
import { mapScopesToPermissions, SCOPES } from "@/lib/api/tokens/scopes";
import { prisma } from "@/lib/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const policyRevisionMocks = vi.hoisted(() => ({
  publish: vi.fn(),
}));

// Route imports
import {
  GET as getAccounts,
  POST as postAccounts,
} from "../../app/(ee)/api/shopify/loyalty/admin/accounts/route";
import { GET as getActivity } from "../../app/(ee)/api/shopify/loyalty/admin/activity/route";
import { POST as postAdjust } from "../../app/(ee)/api/shopify/loyalty/admin/adjust/route";
import { POST as postBackfill } from "../../app/(ee)/api/shopify/loyalty/admin/backfill/route";
import { POST as postSettings } from "../../app/(ee)/api/shopify/loyalty/admin/settings/route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: policyRevisionMocks.publish,
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb) => {
      try {
        if (typeof cb === "function") cb();
      } catch {}
    }),
  };
});
vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (fn: any) => fn,
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), flush: vi.fn() },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: vi.fn() })),
}));

let currentTestRole = "owner";
let currentUserId = "usr_owner_1";
let currentWorkspaceId = "ws_tenant_a";

vi.mock("@/lib/auth/utils", () => ({
  getSession: vi.fn(async () => ({
    user: { id: currentUserId, email: "user@weletic.com" },
  })),
}));

vi.mock("@/lib/auth/workspace-cache", () => ({
  workspaceAuthCache: {
    get: vi.fn(({ identifier, userId }) => {
      if (identifier === "ws_invalid") return null;
      return {
        id: identifier || currentWorkspaceId,
        slug: "test-workspace",
        plan: "enterprise",
        users: [
          {
            userId: currentUserId,
            role: currentTestRole,
            defaultFolderId: null,
            workspacePreferences: null,
          },
        ],
      };
    }),
    set: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: vi.fn(), findFirst: vi.fn() },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticLoyaltyBackfillJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyBackfillPreviewItem: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    weleticRewardDefinition: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyTier: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyEarningRule: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyBonusCampaign: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticShopper: { findFirst: vi.fn(), findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

describe("M1: Security Boundary & RBAC Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentTestRole = "owner";
    currentUserId = "usr_owner_1";
    currentWorkspaceId = "ws_tenant_a";
    policyRevisionMocks.publish.mockResolvedValue({ id: "wpolicy_test" });
  });

  describe("1. RBAC Permissions, Resources & Scopes Registration", () => {
    it("includes loyalty in RESOURCE_KEYS and RESOURCES", () => {
      expect(RESOURCE_KEYS).toContain("loyalty");
      const loyaltyResource = RESOURCES.find((r) => r.key === "loyalty");
      expect(loyaltyResource).toBeDefined();
      expect(loyaltyResource?.name).toBe("Loyalty");
    });

    it("registers loyalty.read and loyalty.write in PERMISSION_ACTIONS and ROLE_PERMISSIONS", () => {
      const ownerPerms = getPermissionsByRole("owner");
      const memberPerms = getPermissionsByRole("member");
      const viewerPerms = getPermissionsByRole("viewer");
      const billingPerms = getPermissionsByRole("billing");

      expect(ownerPerms).toContain("loyalty.read");
      expect(ownerPerms).toContain("loyalty.write");
      expect(memberPerms).toContain("loyalty.read");
      expect(memberPerms).toContain("loyalty.write");
      expect(viewerPerms).toContain("loyalty.read");
      expect(viewerPerms).not.toContain("loyalty.write");
      expect(billingPerms).toContain("loyalty.read");
      expect(billingPerms).not.toContain("loyalty.write");
    });

    it("correctly maps token scopes for loyalty.read and loyalty.write", () => {
      expect(SCOPES).toContain("loyalty.read");
      expect(SCOPES).toContain("loyalty.write");

      const readPerms = mapScopesToPermissions(["loyalty.read"]);
      expect(readPerms).toEqual(["loyalty.read"]);

      const writePerms = mapScopesToPermissions(["loyalty.write"]);
      expect(writePerms).toContain("loyalty.write");
      expect(writePerms).toContain("loyalty.read");

      const apisReadPerms = mapScopesToPermissions(["apis.read"]);
      expect(apisReadPerms).toContain("loyalty.read");

      const apisAllPerms = mapScopesToPermissions(["apis.all"]);
      expect(apisAllPerms).toContain("loyalty.read");
      expect(apisAllPerms).toContain("loyalty.write");
    });
  });

  describe("2. Authoritative Store Derivation strictly from workspace.id", () => {
    it("ignores caller-supplied storeId/shop and derives from authenticated workspace.id", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
        shopDomain: "store-a.myshopify.com",
        shopCurrency: "USD",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        [],
      );

      // Caller attempts to supply malicious storeId "store_tenant_b_attacker"
      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a&storeId=store_tenant_b_attacker",
      ) as any;
      const res = await getAccounts(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(200);
      expect(prisma.weleticShopifyStore.findUnique).toHaveBeenCalledWith({
        where: { projectId: "ws_tenant_a" },
      });
      // Verification that query was filtered by store_tenant_a, NOT attacker store
      expect(prisma.weleticLoyaltyAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ storeId: "store_tenant_a" }),
        }),
      );
    });

    it("returns 404 when workspace has no connected Shopify store", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(
        null,
      );

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a",
      ) as any;
      const res = await getAccounts(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.message).toContain("Shopify store not connected");
    });
  });

  describe("3. Owner Authorization Guard on Sensitive Operations", () => {
    it("rejects non-owner (member) on program status toggle with 403 Forbidden", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "disabled" }),
        },
      ) as any;
      const res = await postSettings(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe("forbidden");
      expect(data.error.message).toContain("Only workspace owners");
    });

    it("rejects non-owner (member) on kill switch toggle with 403 Forbidden", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ killSwitchActive: true }),
        },
      ) as any;
      const res = await postSettings(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
    });

    it("rejects non-owner (member) on backfill commit/cancel with 403 Forbidden", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/backfill?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "commit", jobId: "job_123" }),
        },
      ) as any;
      const res = await postBackfill(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe("forbidden");
    });

    it("rejects non-owner (member) on ledger CSV export with 403 Forbidden", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/activity?workspaceId=ws_tenant_a&format=csv",
      ) as any;
      const res = await getActivity(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe("forbidden");
    });

    it("rejects non-owner (member) on manual points adjustments with 403 Forbidden", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
      } as any);

      const reqAdjust = new Request(
        "http://localhost/api/shopify/loyalty/admin/adjust?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: "acc_1", pointsDelta: 100 }),
        },
      ) as any;
      const resAdjust = await postAdjust(reqAdjust, {
        params: Promise.resolve({}),
      });
      expect(resAdjust.status).toBe(403);

      const reqAccounts = new Request(
        "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: "acc_1", pointsDelta: 100 }),
        },
      ) as any;
      const resAccounts = await postAccounts(reqAccounts, {
        params: Promise.resolve({}),
      });
      expect(resAccounts.status).toBe(403);
    });

    it("allows owner to execute sensitive operations successfully", async () => {
      currentTestRole = "owner";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_tenant_a",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValueOnce({
        id: "wprog_1",
        storeId: "store_tenant_a",
        status: "active",
        killSwitchActive: false,
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "active", killSwitchActive: false }),
        },
      ) as any;
      const res = await postSettings(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
    });
  });
});
