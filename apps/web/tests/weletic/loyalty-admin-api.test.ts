import { prisma } from "@/lib/prisma";
import { escapeCsvUntrustedTextCell } from "@/lib/weletic/loyalty/csv";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  createRewardDefinition,
  updateRewardDefinition,
} from "@/lib/weletic/loyalty/rewards";
import {
  createLoyaltyTier,
  listLoyaltyTiers,
  updateLoyaltyTier,
} from "@/lib/weletic/loyalty/tiers";
import {
  Prisma,
  WeleticPointsLedgerEntryType,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as getAccounts,
  POST as postAccounts,
} from "../../app/(ee)/api/shopify/loyalty/admin/accounts/route";
import { GET as getActivity } from "../../app/(ee)/api/shopify/loyalty/admin/activity/route";
import { GET as getAnalyticsCohorts } from "../../app/(ee)/api/shopify/loyalty/admin/analytics/cohorts/route";
import { GET as getAnalyticsExport } from "../../app/(ee)/api/shopify/loyalty/admin/analytics/export/route";
import { GET as getAnalytics } from "../../app/(ee)/api/shopify/loyalty/admin/analytics/route";
import { POST as postBackfill } from "../../app/(ee)/api/shopify/loyalty/admin/backfill/route";
import {
  GET as getBranding,
  POST as postBranding,
} from "../../app/(ee)/api/shopify/loyalty/admin/branding/route";
import { POST as postCampaigns } from "../../app/(ee)/api/shopify/loyalty/admin/campaigns/route";
import { POST as postEarnRules } from "../../app/(ee)/api/shopify/loyalty/admin/earn-rules/route";
import {
  PATCH as patchReferrals,
  POST as postReferrals,
} from "../../app/(ee)/api/shopify/loyalty/admin/referrals/route";
import { POST as postRewards } from "../../app/(ee)/api/shopify/loyalty/admin/rewards/route";
import {
  GET as getSettings,
  POST as postSettings,
} from "../../app/(ee)/api/shopify/loyalty/admin/settings/route";
import {
  parseLoyaltyPointInteger,
  toLoyaltyActivityTableRow,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/api-client";

const policyRevisionMocks = vi.hoisted(() => ({
  publish: vi.fn(),
}));
const backfillMocks = vi.hoisted(() => ({
  cancelJob: vi.fn(),
  commitJob: vi.fn(),
  createJob: vi.fn(),
  generatePreview: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: policyRevisionMocks.publish,
}));
vi.mock("@/lib/weletic/loyalty/backfill", () => ({
  cancelBackfillJob: backfillMocks.cancelJob,
  commitBackfillJob: backfillMocks.commitJob,
  createBackfillJob: backfillMocks.createJob,
  generateBackfillPreview: backfillMocks.generatePreview,
  getBackfillJob: backfillMocks.getJob,
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

vi.mock("@/lib/auth/rate-limit-request", () => ({
  rateLimitRequest: vi.fn(async () => ({
    success: true,
    headers: {},
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyTier: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyBonusCampaign: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    weleticRewardDefinition: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    weleticLoyaltyBackfillJob: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyBackfillPreviewItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyBackfillOrderSnapshot: {
      findMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    weleticShopper: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

describe("Merchant Admin Loyalty Engine APIs", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    currentTestRole = "owner";
    currentUserId = "usr_owner_1";
    currentWorkspaceId = "ws_tenant_a";
    policyRevisionMocks.publish.mockResolvedValue({ id: "wpolicy_test" });
  });

  describe("Immutable earn-policy initialization", () => {
    const settingsUrl =
      "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a";
    function mockLifecycleStore() {
      const store = {
        id: "store_lifecycle",
        projectId: "ws_tenant_a",
        programId: "affiliate_lifecycle",
        shopDomain: "lifecycle.myshopify.com",
        defaultLocale: "en",
        apiVersion: "2026-07",
        syncStatus: "pending" as const,
        lastFullSyncAt: null,
        lastIncrementalAt: null,
        lastReconciledAt: null,
        lastSyncError: null,
        uninstalledAt: null,
        redactedAt: null,
        financialRetentionUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        complianceState: "active" as const,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date(),
        installationGeneration: "g1",
        program: { accountingCurrency: "USD" },
      };
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue(store);
    }

    it("initializes settings as draft on read without activating loyalty", async () => {
      mockLifecycleStore();
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(
        null,
      );
      vi.mocked(prisma.weleticLoyaltyProgram.create).mockResolvedValue({
        id: "program_draft",
        storeId: "store_lifecycle",
        status: "draft",
      } as Awaited<ReturnType<typeof prisma.weleticLoyaltyProgram.create>>);
      const response = await getSettings(new NextRequest(settingsUrl), {
        params: Promise.resolve({}),
      });
      expect(response.status).toBe(200);
      expect(prisma.weleticLoyaltyProgram.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "draft" }),
        }),
      );
    });

    it("reuses a program initialized by another request after acquiring the write fence", async () => {
      mockLifecycleStore();
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "program_race",
          storeId: "store_lifecycle",
          status: "disabled",
        } as Awaited<
          ReturnType<typeof prisma.weleticLoyaltyProgram.findUnique>
        >);
      const response = await getSettings(new NextRequest(settingsUrl), {
        params: Promise.resolve({}),
      });
      expect(response.status).toBe(200);
      expect(prisma.weleticLoyaltyProgram.create).not.toHaveBeenCalled();
      expect(policyRevisionMocks.publish).not.toHaveBeenCalled();
    });

    it.each([
      {
        role: "member",
        body: { name: "Review-only merchant", pointsExpiryDays: 90 },
        expected: "draft",
      },
      {
        role: "owner",
        body: { status: "active", pointsExpiryDays: 90 },
        expected: "active",
      },
    ])(
      "requires explicit activation rather than a settings write: $role / $expected",
      async ({ role, body, expected }) => {
        mockLifecycleStore();
        currentTestRole = role;
        vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(
          null,
        );
        vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
          id: "program_new",
          storeId: "store_lifecycle",
          status: expected,
        } as Awaited<ReturnType<typeof prisma.weleticLoyaltyProgram.upsert>>);
        const response = await postSettings(
          new NextRequest(settingsUrl, {
            method: "POST",
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({}) },
        );
        expect(response.status).toBe(200);
        expect(prisma.weleticLoyaltyProgram.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              status: expected,
              pointsExpiryPolicyAnchorAt:
                expected === "active" ? expect.any(Date) : null,
            }),
          }),
        );
      },
    );

    it.each([null, "", "enabled", true, 1])(
      "rejects invalid explicit status %j before any program write",
      async (status) => {
        mockLifecycleStore();
        const response = await postSettings(
          new NextRequest(settingsUrl, {
            method: "POST",
            body: JSON.stringify({ status }),
          }),
          { params: Promise.resolve({}) },
        );
        expect(response.status).toBe(400);
        expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
      },
    );

    it("publishes a baseline revision in the transaction that initializes a missing backfill program", async () => {
      const createdAt = new Date("2026-09-02T00:00:00.000Z");
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_backfill",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce(
        null,
      );
      vi.mocked(prisma.weleticLoyaltyProgram.create).mockResolvedValueOnce({
        id: "wprog_backfill",
        storeId: "store_backfill",
        name: "Customer Loyalty Program",
      } as any);
      backfillMocks.createJob.mockResolvedValueOnce({
        id: "wbackfill_initial",
        storeId: "store_backfill",
        programId: "wprog_backfill",
        status: "pending",
        lookbackDays: 30,
        lookbackStartDate: null,
        pointsPerCurrencyUnit: 1,
        minOrderAmount: null,
        totalShoppersCount: 0,
        totalOrdersCount: 0,
        totalProjectedPoints: BigInt(0),
        processedAccountsCount: 0,
        totalCommittedPoints: BigInt(0),
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      });
      backfillMocks.generatePreview.mockResolvedValueOnce({
        id: "wbackfill_initial",
        storeId: "store_backfill",
        programId: "wprog_backfill",
        status: "preview_ready",
        lookbackDays: 30,
        lookbackStartDate: null,
        pointsPerCurrencyUnit: 1,
        minOrderAmount: null,
        totalShoppersCount: 0,
        totalOrdersCount: 0,
        totalProjectedPoints: BigInt(0),
        processedAccountsCount: 0,
        totalCommittedPoints: BigInt(0),
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      });
      vi.mocked(
        prisma.weleticLoyaltyBackfillOrderSnapshot.findMany,
      ).mockResolvedValueOnce([]);

      const response = await postBackfill(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/backfill?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "preview", lookbackDays: 30 }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      expect(policyRevisionMocks.publish).toHaveBeenCalledOnce();
      expect(policyRevisionMocks.publish).toHaveBeenCalledWith({
        tx: prisma,
        storeId: "store_backfill",
        programId: "wprog_backfill",
        reason: "loyalty_program_initialized_from_backfill",
      });
      expect(backfillMocks.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store_backfill",
          programId: "wprog_backfill",
        }),
      );
    });
  });

  describe("Historical backfill containment", () => {
    it("rejects an owner commit after tenant validation without invoking the unsafe writer", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_backfill",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyBackfillJob.findUnique,
      ).mockResolvedValueOnce({
        id: "wbackfill_preview",
        storeId: "store_backfill",
        status: "preview_ready",
      } as any);

      const response = await postBackfill(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/backfill?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "commit",
              jobId: "wbackfill_preview",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "backfill_commits_temporarily_disabled",
          message: expect.stringContaining("temporarily disabled"),
        },
      });
      expect(backfillMocks.commitJob).not.toHaveBeenCalled();
    });
  });

  describe("On-site branding contract", () => {
    const requestUrl =
      "http://localhost/api/shopify/loyalty/admin/branding?workspaceId=ws_tenant_a";

    it("returns a complete normalized branding object from partial legacy JSON", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "wprog_1",
        storeId: "store_1",
        name: "Yamax Points",
        branding: {
          launcherText: "  Yamax Rewards  ",
          primaryColor: "unsafe-css",
          heroImageUrl: "https://cdn.example.com/yamax-hero.jpg",
          legacyField: "ignored on reads",
        },
      } as any);

      const response = await getBranding(new Request(requestUrl) as any, {
        params: Promise.resolve({}),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          programId: "wprog_1",
          branding: {
            launcherText: "Yamax Rewards",
            launcherPosition: "bottom_right",
            launcherIcon: "gift",
            primaryColor: "#059669",
            headerTextColor: "#ffffff",
            panelTitle: "Yamax Points",
            heroImageUrl: "https://cdn.example.com/yamax-hero.jpg",
            enableFloatingLauncher: true,
          },
        },
      });
    });

    it("bounds a legacy program name so the default branding can be saved again", async () => {
      const longProgramName = `Yamax ${"Rewards ".repeat(20)}`;
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "wprog_1",
        storeId: "store_1",
        name: longProgramName,
        branding: null,
      } as any);

      const response = await getBranding(new Request(requestUrl) as any, {
        params: Promise.resolve({}),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.branding.panelTitle).toBe(
        longProgramName.trim().slice(0, 100),
      );
      expect(payload.data.branding.panelTitle).toHaveLength(100);
    });

    it("merges a validated partial branding write over the stored configuration", async () => {
      const storedProgram = {
        id: "wprog_1",
        storeId: "store_1",
        name: "Yamax Points",
        metadata: null,
        branding: {
          launcherIcon: "crown",
          primaryColor: "#ABCDEF",
          panelWelcomeSubtitle: "Existing member message",
        },
      } as any;
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(
        storedProgram,
      );
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue(
        storedProgram,
      );
      vi.mocked(prisma.weleticLoyaltyProgram.update).mockResolvedValue({
        ...storedProgram,
        branding: {
          launcherText: "Yamax VIP",
          launcherPosition: "bottom_right",
          launcherIcon: "crown",
          primaryColor: "#abcdef",
          headerTextColor: "#fdfdfd",
          panelTitle: "Yamax Points",
          panelWelcomeSubtitle: "Existing member message",
          heroImageUrl: "https://cdn.example.com/vip.jpg",
          enableFloatingLauncher: true,
        },
      } as any);

      const response = await postBranding(
        new Request(requestUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            branding: {
              launcherText: "  Yamax VIP  ",
              headerTextColor: "#FDFDFD",
              heroImageUrl: "https://cdn.example.com/vip.jpg",
            },
          }),
        }) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          success: true,
          branding: {
            launcherText: "Yamax VIP",
            launcherIcon: "crown",
            primaryColor: "#abcdef",
            headerTextColor: "#fdfdfd",
            panelTitle: "Yamax Points",
            panelWelcomeSubtitle: "Existing member message",
            heroImageUrl: "https://cdn.example.com/vip.jpg",
          },
        },
      });
      expect(prisma.weleticLoyaltyProgram.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            branding: expect.objectContaining({
              launcherText: "Yamax VIP",
              primaryColor: "#abcdef",
              headerTextColor: "#fdfdfd",
            }),
          },
        }),
      );
    });

    it.each([
      ["unknown field", { trackingScript: "alert(1)" }],
      ["unsafe hero URL", { heroImageUrl: "javascript:alert(1)" }],
      ["invalid color", { primaryColor: "red; background:url(x)" }],
    ])("rejects %s in merchant branding input", async (_label, branding) => {
      const storedProgram = {
        id: "wprog_1",
        storeId: "store_1",
        name: "Yamax Points",
        metadata: null,
        branding: null,
      } as any;
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(
        storedProgram,
      );
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue(
        storedProgram,
      );

      const response = await postBranding(
        new Request(requestUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ branding }),
        }) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "bad_request" },
      });
      expect(prisma.weleticLoyaltyProgram.update).not.toHaveBeenCalled();
    });
  });

  describe("VIP Tier Management", () => {
    it("creates, updates, and lists VIP tiers", async () => {
      vi.mocked(prisma.weleticLoyaltyTier.create).mockResolvedValueOnce({
        id: "wtier_platinum",
        programId: "prog_1",
        name: "Platinum Elite",
        slug: "platinum-elite",
        tierOrder: 3,
        minSpendThreshold: BigInt(100000),
        minPointsThreshold: BigInt(1000),
        pointsMultiplier: 1.5 as any,
        perks: ["Free shipping", "Early access"] as any,
        iconUrl: "https://example.com/platinum.png",
        entryBonusPoints: BigInt(250),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const created = await createLoyaltyTier(
        {
          programId: "prog_1",
          name: "Platinum Elite",
          slug: "platinum-elite",
          tierOrder: 3,
          minSpendThreshold: BigInt(100000),
          minPointsThreshold: BigInt(1000),
          pointsMultiplier: 1.5,
          perks: ["Free shipping", "Early access"],
          iconUrl: "https://example.com/platinum.png",
          entryBonusPoints: BigInt(250),
        },
        prisma as unknown as Prisma.TransactionClient,
      );

      expect(created.name).toBe("Platinum Elite");
      expect(created.tierOrder).toBe(3);

      vi.mocked(prisma.weleticLoyaltyTier.update).mockResolvedValueOnce({
        id: "wtier_platinum",
        programId: "prog_1",
        name: "Diamond Elite",
        slug: "diamond-elite",
        tierOrder: 4,
        minSpendThreshold: BigInt(150000),
        minPointsThreshold: BigInt(1500),
        pointsMultiplier: 2.0 as any,
        perks: ["VIP Concierge"] as any,
        iconUrl: "badge:purple",
        entryBonusPoints: BigInt(500),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const updated = await updateLoyaltyTier(
        "wtier_platinum",
        {
          name: "Diamond Elite",
          slug: "diamond-elite",
          tierOrder: 4,
          minSpendThreshold: BigInt(150000),
          pointsMultiplier: 2.0,
        },
        prisma as unknown as Prisma.TransactionClient,
      );

      expect(updated.name).toBe("Diamond Elite");
      expect(updated.tierOrder).toBe(4);

      vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValueOnce([
        created,
        updated,
      ] as any);

      const list = await listLoyaltyTiers("prog_1");
      expect(list).toHaveLength(2);
    });
  });

  describe("Bonus Campaign History Invariants", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
        id: "wprog_1",
        storeId: "store_1",
      } as any);
      vi.mocked(prisma.weleticLoyaltyTier.count).mockResolvedValue(0);
    });

    it("publishes the post-write earn policy in the same transaction", async () => {
      vi.mocked(
        prisma.weleticLoyaltyBonusCampaign.findFirst,
      ).mockResolvedValueOnce(null);
      vi.mocked(
        prisma.weleticLoyaltyBonusCampaign.create,
      ).mockResolvedValueOnce({
        id: "wcamp_revision123",
        programId: "wprog_1",
        name: "Revision campaign",
      } as any);

      const response = await postCampaigns(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/campaigns?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Revision campaign",
              multiplier: 2,
              startAt: "2026-09-10T00:00:00.000Z",
              endAt: "2026-09-20T00:00:00.000Z",
              eligibleSkus: [" SKU-B ", "SKU-A", "SKU-A"],
              eligibleCollectionIds: [
                "gid://shopify/Collection/42",
                "gid://shopify/Collection/42",
              ],
              isActive: true,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      expect(prisma.weleticLoyaltyBonusCampaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eligibleSkus: ["SKU-A", "SKU-B"],
          eligibleCollectionIds: ["gid://shopify/Collection/42"],
        }),
      });
      expect(policyRevisionMocks.publish).toHaveBeenCalledWith({
        tx: prisma,
        storeId: "store_1",
        programId: "wprog_1",
        reason: "bonus_campaign_created",
      });
    });

    it("preserves product targets when a legacy update omits the new fields", async () => {
      vi.mocked(
        prisma.weleticLoyaltyBonusCampaign.findFirst,
      ).mockResolvedValueOnce({
        id: "wcamp_legacyupdate123",
        programId: "wprog_1",
        name: "Legacy client campaign",
        startAt: new Date("2026-09-10T00:00:00.000Z"),
        endAt: new Date("2026-09-20T00:00:00.000Z"),
        eligibleSkus: ["SKU-KEEP"],
        eligibleCollectionIds: ["gid://shopify/Collection/42"],
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyBonusCampaign.update,
      ).mockResolvedValueOnce({
        id: "wcamp_legacyupdate123",
        programId: "wprog_1",
        name: "Legacy client campaign renamed",
      } as any);

      const response = await postCampaigns(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/campaigns?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              campaignId: "wcamp_legacyupdate123",
              name: "Legacy client campaign renamed",
              multiplier: 2,
              startAt: "2026-09-10T00:00:00.000Z",
              endAt: "2026-09-20T00:00:00.000Z",
              isActive: false,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const updateData = vi.mocked(prisma.weleticLoyaltyBonusCampaign.update)
        .mock.calls[0][0].data;
      expect(updateData).not.toHaveProperty("eligibleSkus");
      expect(updateData).not.toHaveProperty("eligibleCollectionIds");
    });

    it.each([1.49, 10.01])(
      "rejects an out-of-range %sx multiplier at the admin API boundary",
      async (multiplier) => {
        const response = await postCampaigns(
          new Request(
            "http://localhost/api/shopify/loyalty/admin/campaigns?workspaceId=ws_tenant_a",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: "Invalid multiplier",
                multiplier,
                startAt: "2026-09-10T00:00:00.000Z",
                endAt: "2026-09-20T00:00:00.000Z",
                isActive: true,
              }),
            },
          ) as any,
          { params: Promise.resolve({}) },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: {
            code: "bad_request",
            message: "Campaign multiplier must be between 1.5 and 10.",
          },
        });
        expect(
          prisma.weleticLoyaltyBonusCampaign.create,
        ).not.toHaveBeenCalled();
      },
    );

    it("rejects non-canonical collection targets at the admin boundary", async () => {
      const response = await postCampaigns(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/campaigns?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Invalid collection target",
              multiplier: 2,
              startAt: "2026-09-10T00:00:00.000Z",
              endAt: "2026-09-20T00:00:00.000Z",
              eligibleCollectionIds: ["42"],
              isActive: true,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "bad_request",
          message:
            "eligibleCollectionIds contains an invalid Shopify collection GID.",
        },
      });
      expect(prisma.weleticLoyaltyBonusCampaign.create).not.toHaveBeenCalled();
    });

    it("retains started campaign economics as immutable history", async () => {
      vi.mocked(prisma.weleticLoyaltyBonusCampaign.findFirst).mockResolvedValue(
        {
          id: "wcamp_started123",
          programId: "wprog_1",
          name: "Started campaign",
          startAt: new Date("2026-08-01T00:00:00.000Z"),
          endAt: new Date("2026-08-15T00:00:00.000Z"),
          isActive: true,
        } as any,
      );

      const response = await postCampaigns(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/campaigns?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              campaignId: "wcamp_started123",
              name: "Rewrite history",
              multiplier: 5,
              startAt: "2026-09-10T00:00:00.000Z",
              endAt: "2026-09-20T00:00:00.000Z",
              isActive: true,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(409);
      expect(prisma.weleticLoyaltyBonusCampaign.update).not.toHaveBeenCalled();
    });

    it("rejects overlapping active campaigns inside the serializable write", async () => {
      vi.mocked(prisma.weleticLoyaltyBonusCampaign.findFirst).mockResolvedValue(
        {
          id: "wcamp_existing123",
          name: "Existing campaign",
        } as any,
      );

      const response = await postCampaigns(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/campaigns?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Overlapping campaign",
              multiplier: 2,
              startAt: "2026-09-10T00:00:00.000Z",
              endAt: "2026-09-20T00:00:00.000Z",
              isActive: true,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(409);
      expect(prisma.weleticLoyaltyBonusCampaign.create).not.toHaveBeenCalled();
    });
  });

  describe("Reward Catalog Management", () => {
    it("creates, updates, and lists reward definitions", async () => {
      vi.mocked(prisma.weleticRewardDefinition.create).mockResolvedValueOnce({
        id: "wreward_free_shipping",
        storeId: "store_1",
        name: "Free Express Shipping",
        description: "Free express shipping coupon",
        rewardType: WeleticRewardType.free_shipping,
        pointsCost: BigInt(300),
        discountValue: null,
        minOrderAmount: null,
        status: WeleticRewardStatus.active,
        shopifyPriceRuleId: "rule_123",
        usageLimit: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const reward = await createRewardDefinition({
        storeId: "store_1",
        name: "Free Express Shipping",
        description: "Free express shipping coupon",
        rewardType: WeleticRewardType.free_shipping,
        pointsCost: 300,
        shopifyPriceRuleId: "rule_123",
        usageLimit: 1,
      });

      expect(reward.name).toBe("Free Express Shipping");
      expect(reward.pointsCost).toBe(BigInt(300));

      vi.mocked(prisma.weleticRewardDefinition.update).mockResolvedValueOnce({
        ...reward,
        pointsCost: BigInt(250),
        status: WeleticRewardStatus.archived,
      } as any);
      vi.mocked(
        prisma.weleticRewardDefinition.findUnique,
      ).mockResolvedValueOnce(reward as any);

      const updated = await updateRewardDefinition({
        id: reward.id,
        storeId: "store_1",
        data: {
          pointsCost: 250,
          status: WeleticRewardStatus.archived,
        },
      });

      expect(updated.status).toBe(WeleticRewardStatus.archived);
    });

    it("rejects sub-one percentage values at the admin API boundary", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Invalid 0.99% reward",
            rewardType: WeleticRewardType.percentage_off,
            pointsCost: 100,
            discountValue: 0.99,
          }),
        },
      ) as any;

      const res = await postRewards(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: "bad_request",
          message: "Percentage rewards must be between 1 and 100.",
        },
      });
      expect(prisma.weleticRewardDefinition.create).not.toHaveBeenCalled();
    });

    it("rejects unsupported per-customer voucher limits at the admin API boundary", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Unsupported two-per-customer reward",
            rewardType: WeleticRewardType.amount_off,
            pointsCost: 100,
            discountValue: 500,
            usageLimitPerCustomer: 2,
          }),
        },
      ) as any;

      const res = await postRewards(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: "bad_request",
          message:
            "usageLimitPerCustomer must be 0 (unlimited) or 1 (once per customer).",
        },
      });
      expect(prisma.weleticRewardDefinition.create).not.toHaveBeenCalled();
    });

    it("rejects unknown sales channels at the admin API boundary", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Invalid sales channel reward",
            rewardType: WeleticRewardType.amount_off,
            salesChannel: "marketplace",
            pointsCost: 100,
            discountValue: 500,
          }),
        },
      ) as any;

      const res = await postRewards(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: "bad_request",
          message: "salesChannel must be online_store, pos, or both.",
        },
      });
      expect(prisma.weleticRewardDefinition.create).not.toHaveBeenCalled();
    });

    it.each([
      ["boolean", true],
      ["array", [1]],
    ])(
      "rejects a non-decimal %s percentage value at the admin API boundary",
      async (_label, discountValue) => {
        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
          id: "store_1",
          projectId: "ws_tenant_a",
        } as any);
        const req = new Request(
          "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Invalid percentage reward",
              rewardType: WeleticRewardType.percentage_off,
              pointsCost: 100,
              discountValue,
            }),
          },
        ) as any;

        const res = await postRewards(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          error: { code: "bad_request" },
        });
        expect(prisma.weleticRewardDefinition.create).not.toHaveBeenCalled();
      },
    );
  });

  describe("Referral Rule Invariants", () => {
    const savedRule = (overrides: Record<string, unknown> = {}) =>
      ({
        id: "wreferral_rule_1",
        programId: "wprog_1",
        advocatePointsReward: BigInt(500),
        refereePointsReward: BigInt(50),
        advocateRewardKind: "points",
        refereeRewardKind: "points",
        advocateRewardDefinitionId: null,
        refereeRewardDefinitionId: null,
        minQualifyingOrderSubtotal: new Prisma.Decimal(30),
        maxReferralsPerAdvocate: 10,
        fraudCheckSameIp: true,
        isActive: true,
        ...overrides,
      }) as any;

    function referralRuleRequest(body: Record<string, unknown>) {
      return new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ) as any;
    }

    beforeEach(() => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_1",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
        id: "wprog_1",
        storeId: "store_1",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mockResolvedValue(
        savedRule(),
      );
      vi.mocked(prisma.weleticLoyaltyReferralRule.updateMany).mockResolvedValue(
        {
          count: 0,
        },
      );
    });

    it("restricts financial referral review actions to workspace owners", async () => {
      currentTestRole = "member";

      const response = await patchReferrals(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_a",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              referralId: "wreferral_review",
              action: "cancel",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(403);
      expect(prisma.weleticLoyaltyReferral.findMany).not.toHaveBeenCalled();
    });

    it("deactivates every active legacy rule when the program is disabled", async () => {
      vi.mocked(prisma.weleticLoyaltyReferralRule.update).mockResolvedValue(
        savedRule({ isActive: false }),
      );
      vi.mocked(prisma.weleticLoyaltyReferralRule.updateMany).mockResolvedValue(
        {
          count: 2,
        },
      );

      const res = await postReferrals(
        referralRuleRequest({
          ruleId: "wreferral_rule_1",
          isActive: false,
          maxReferralsPerAdvocate: 10,
        }),
        { params: Promise.resolve({}) },
      );

      expect(res.status).toBe(200);
      expect(prisma.weleticLoyaltyReferralRule.updateMany).toHaveBeenCalledWith(
        {
          where: { programId: "wprog_1", isActive: true },
          data: { isActive: false },
        },
      );
    });

    it("retries a concurrent serializable admin save after P2034", async () => {
      vi.mocked(prisma.weleticLoyaltyReferralRule.update).mockResolvedValue(
        savedRule(),
      );
      const writeConflict = new Prisma.PrismaClientKnownRequestError(
        "Transaction write conflict",
        { code: "P2034", clientVersion: "test" },
      );
      vi.mocked(prisma.$transaction)
        .mockRejectedValueOnce(writeConflict)
        .mockImplementationOnce(((operation: (tx: typeof prisma) => unknown) =>
          operation(prisma)) as any);

      const res = await postReferrals(
        referralRuleRequest({
          ruleId: "wreferral_rule_1",
          isActive: true,
          maxReferralsPerAdvocate: 10,
        }),
        { params: Promise.resolve({}) },
      );

      expect(res.status).toBe(200);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.weleticLoyaltyProgram.updateMany).toHaveBeenCalledTimes(1);
    });

    it("rejects an active fixed coupon that Shopify cannot provision", async () => {
      vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue({
        id: "wreward_invalid",
        storeId: "store_1",
        status: WeleticRewardStatus.active,
        exchangeType: "fixed",
        rewardType: WeleticRewardType.amount_off,
        discountValue: null,
        maxDiscountValue: null,
        minOrderAmount: null,
        entitledProductIds: [],
        entitledVariantIds: [],
        entitledCollectionIds: [],
        usageLimit: 1,
      } as any);

      const res = await postReferrals(
        referralRuleRequest({
          advocateRewardKind: "coupon",
          advocateRewardDefinitionId: "wreward_invalid",
          refereeRewardKind: "points",
          isActive: true,
        }),
        { params: Promise.resolve({}) },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: "bad_request",
          message:
            "advocate coupon reward is invalid, cannot be provisioned, or belongs to another store.",
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(prisma.weleticLoyaltyProgram.upsert).toHaveBeenCalledOnce();
      expect(prisma.weleticLoyaltyProgram.updateMany).toHaveBeenCalledOnce();
      expect(
        vi.mocked(prisma.weleticLoyaltyProgram.updateMany).mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(prisma.weleticRewardDefinition.findFirst).mock
          .invocationCallOrder[0],
      );
      expect(prisma.weleticLoyaltyReferralRule.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyReferralRule.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        "disabled",
        {
          id: "wreward_concurrent",
          storeId: "store_1",
          status: WeleticRewardStatus.inactive,
          exchangeType: "fixed",
          rewardType: WeleticRewardType.amount_off,
          discountValue: new Prisma.Decimal(10),
          maxDiscountValue: null,
          minOrderAmount: null,
          entitledProductIds: [],
          entitledVariantIds: [],
          entitledCollectionIds: [],
          usageLimit: 1,
        },
      ],
      ["deleted", null],
    ])(
      "rejects a coupon rule when a concurrent reward %s wins before the locked re-read",
      async (_state, lockedReward) => {
        vi.mocked(
          prisma.weleticRewardDefinition.findFirst,
        ).mockImplementationOnce((async () => {
          expect(
            prisma.weleticLoyaltyProgram.updateMany,
          ).toHaveBeenCalledOnce();
          return lockedReward as any;
        }) as any);

        const res = await postReferrals(
          referralRuleRequest({
            advocateRewardKind: "coupon",
            advocateRewardDefinitionId: "wreward_concurrent",
            refereeRewardKind: "points",
            isActive: true,
          }),
          { params: Promise.resolve({}) },
        );

        expect(res.status).toBe(400);
        expect(prisma.weleticRewardDefinition.findFirst).toHaveBeenCalledWith({
          where: {
            id: "wreward_concurrent",
            storeId: "store_1",
            status: "active",
            exchangeType: "fixed",
          },
        });
        expect(prisma.weleticLoyaltyReferralRule.create).not.toHaveBeenCalled();
        expect(prisma.weleticLoyaltyReferralRule.update).not.toHaveBeenCalled();
      },
    );
  });

  describe("Manual Points Adjustment", () => {
    it("executes atomic manual adjustment with sequence tracking", async () => {
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_target",
        cachedPointsBalance: BigInt(400),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 5,
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce({
        sequenceNumber: 5,
        balanceAfter: BigInt(400),
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "ledger_adj_1",
        accountId: "acc_target",
        sequenceNumber: 6,
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        pointsDelta: BigInt(150),
        balanceAfter: BigInt(550),
        reason: "Customer Service compensation",
      } as any);

      const entry = await appendPointsLedgerEntry({
        storeId: "store_1",
        accountId: "acc_target",
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        pointsDelta: 150,
        idempotencyKey: "manual_adj_cs_001",
        reason: "Customer Service compensation",
      });

      expect(entry.entryType).toBe(
        WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      );
      expect(entry.pointsDelta).toBe(BigInt(150));
      expect(entry.balanceAfter).toBe(BigInt(550));
    });

    it("does not append a manual adjustment when freeze wins before the guarded mutation", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique)
        .mockResolvedValueOnce({
          id: "store_frozen_adjustment",
          projectId: "ws_tenant_a",
        } as any)
        .mockResolvedValueOnce({
          id: "store_frozen_adjustment",
          complianceState: "frozen",
          shopCurrency: "USD",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "sgen_frozen_adjustment",
        } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: "acc_frozen_adjustment",
        storeId: "store_frozen_adjustment",
        status: "active",
        metadata: null,
      } as any);

      const response = await postAccounts(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accountId: "acc_frozen_adjustment",
              pointsDelta: 100,
              reason: "must not land after freeze",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(500);
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("Frozen Store Program Configuration", () => {
    it("does not reactivate a loyalty program when freeze wins before settings publication", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique)
        .mockResolvedValueOnce({
          id: "store_frozen_settings",
          projectId: "ws_tenant_a",
        } as any)
        .mockResolvedValueOnce({
          id: "store_frozen_settings",
          complianceState: "frozen",
          shopCurrency: "USD",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "sgen_frozen_settings",
        } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "active",
              killSwitchActive: false,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(500);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });
  });

  describe("Holding Period Policy", () => {
    it.each([0, 14, 365])(
      "persists a valid non-negative integer holding period (%s days)",
      async (holdingPeriodDays) => {
        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
          id: "store_holding_settings",
          projectId: "ws_tenant_a",
          complianceState: "active",
          shopCurrency: "USD",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "sgen_holding_settings",
        } as any);
        vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
          id: "wprog_holding_settings",
          storeId: "store_holding_settings",
          status: "active",
          killSwitchActive: false,
          pointsExpiryDays: 0,
          pointsExpiryMonths: 0,
          pointsExpiryWarningDays: 30,
          pointsExpiryLastChanceDays: 3,
          pointsExpiryWarningEnabled: true,
          pointsExpiryLastChanceEnabled: true,
          pointsExpiryPolicyAnchorAt: null,
          pointsExpiryPolicyVersion: 0,
        } as any);
        vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
          id: "wprog_holding_settings",
        } as any);

        const response = await postSettings(
          new Request(
            "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ holdingPeriodDays }),
            },
          ) as any,
          { params: Promise.resolve({}) },
        );

        expect(response.status).toBe(200);
        expect(prisma.weleticLoyaltyProgram.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ holdingPeriodDays }),
          }),
        );
      },
    );

    it.each([-1, 1.5, 366, 2_147_483_647, "seven", false])(
      "rejects invalid holding period value %s",
      async (holdingPeriodDays) => {
        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
          id: "store_holding_settings",
          projectId: "ws_tenant_a",
        } as any);

        const response = await postSettings(
          new Request(
            "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ holdingPeriodDays }),
            },
          ) as any,
          { params: Promise.resolve({}) },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: {
            code: "bad_request",
            message:
              "holdingPeriodDays must be a non-negative integer no greater than 365.",
          },
        });
        expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
      },
    );
  });

  describe("Financial policy input validation", () => {
    it.each([0, -1, "not-a-rate", ""])(
      "rejects an invalid points-per-currency rate (%s)",
      async (pointsPerCurrencyUnit) => {
        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
          id: "store_financial_settings",
          projectId: "ws_tenant_a",
        } as any);

        const response = await postSettings(
          new Request(
            "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pointsPerCurrencyUnit }),
            },
          ) as any,
          { params: Promise.resolve({}) },
        );

        expect(response.status).toBe(400);
        expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
      },
    );

    it("requires all rational liability fields to be updated together", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_financial_settings",
        projectId: "ws_tenant_a",
        program: { accountingCurrency: "JPY" },
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              liabilityValuationCurrency: "JPY",
              liabilityMinorUnitsNumerator: "1",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringMatching(/updated together/) },
      });
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });

    it("rejects a valuation currency that differs from accounting currency", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_financial_settings",
        projectId: "ws_tenant_a",
        program: { accountingCurrency: "JPY" },
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              liabilityValuationCurrency: "USD",
              liabilityMinorUnitsNumerator: "1",
              liabilityPointsDenominator: "100",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringMatching(/accounting currency JPY/) },
      });
    });

    it.each([
      [
        "configures",
        {
          liabilityValuationCurrency: "jpy",
          liabilityMinorUnitsNumerator: "1",
          liabilityPointsDenominator: "100",
        },
        {
          liabilityValuationCurrency: "JPY",
          liabilityMinorUnitsNumerator: BigInt(1),
          liabilityPointsDenominator: BigInt(100),
        },
      ],
      [
        "clears",
        {
          liabilityValuationCurrency: null,
          liabilityMinorUnitsNumerator: null,
          liabilityPointsDenominator: null,
        },
        {
          liabilityValuationCurrency: null,
          liabilityMinorUnitsNumerator: null,
          liabilityPointsDenominator: null,
        },
      ],
    ])(
      "%s an exact rational valuation atomically",
      async (_name, body, expected) => {
        vi.mocked(prisma.weleticShopifyStore.findUnique)
          .mockResolvedValueOnce({
            id: "store_financial_settings",
            projectId: "ws_tenant_a",
            program: { accountingCurrency: "JPY" },
          } as any)
          .mockResolvedValueOnce({
            id: "store_financial_settings",
            complianceState: "active",
            shopCurrency: "JPY",
            currencyVerifiedAt: new Date("2026-09-01T00:00:00Z"),
            installationGeneration: "sgen_financial_settings",
          } as any);
        vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
          id: "wprog_financial_settings",
          storeId: "store_financial_settings",
          status: "active",
          killSwitchActive: false,
          pointsExpiryDays: 0,
          pointsExpiryMonths: 0,
          pointsExpiryWarningDays: 30,
          pointsExpiryLastChanceDays: 3,
          pointsExpiryWarningEnabled: true,
          pointsExpiryLastChanceEnabled: true,
          pointsExpiryPolicyAnchorAt: null,
          pointsExpiryPolicyVersion: 0,
        } as any);
        vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
          id: "wprog_financial_settings",
        } as any);

        const response = await postSettings(
          new Request(
            "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          ) as any,
          { params: Promise.resolve({}) },
        );

        expect(response.status).toBe(200);
        expect(prisma.weleticLoyaltyProgram.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining(expected),
          }),
        );
      },
    );

    it("restricts valuation changes to workspace owners", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_financial_settings",
        projectId: "ws_tenant_a",
        program: { accountingCurrency: "JPY" },
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              liabilityValuationCurrency: "JPY",
              liabilityMinorUnitsNumerator: "1",
              liabilityPointsDenominator: "100",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(403);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });

    it("rejects a valuation outside the signed 64-bit database range", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_financial_settings",
        projectId: "ws_tenant_a",
        program: { accountingCurrency: "JPY" },
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              liabilityValuationCurrency: "JPY",
              liabilityMinorUnitsNumerator: "9223372036854775808",
              liabilityPointsDenominator: "100",
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });

    it.each([
      [
        "tax-and-shipping-inclusive basis",
        { excludeTaxesAndShipping: false },
        /taxes and shipping/i,
      ],
      ["zero points cap", { maxPointsPerEvent: 0 }, /positive integer/i],
      ["negative order minimum", { minOrderSubtotal: -1 }, /non-negative/i],
    ])("rejects an order rule with %s", async (_scenario, overrides, error) => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_financial_rule",
        projectId: "ws_tenant_a",
      } as any);

      const response = await postEarnRules(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/earn-rules?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Unsafe order rule",
              triggerCode: "order_paid",
              multiplier: 1,
              ...overrides,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringMatching(error) },
      });
      expect(policyRevisionMocks.publish).not.toHaveBeenCalled();
    });
  });

  describe("Points Expiry Policy", () => {
    it("anchors first enablement and advances the reconciliation version", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_expiry_settings",
        projectId: "ws_tenant_a",
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
        installationGeneration: "sgen_expiry_settings",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "wprog_expiry_settings",
        storeId: "store_expiry_settings",
        status: "active",
        killSwitchActive: false,
        pointsExpiryDays: 0,
        pointsExpiryMonths: 0,
        pointsExpiryWarningDays: 30,
        pointsExpiryLastChanceDays: 3,
        pointsExpiryWarningEnabled: true,
        pointsExpiryLastChanceEnabled: true,
        pointsExpiryPolicyAnchorAt: null,
        pointsExpiryPolicyVersion: 7,
        metadata: null,
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
        id: "wprog_expiry_settings",
        storeId: "store_expiry_settings",
        pointsExpiryMonths: 12,
      } as any);

      const requestStartedAt = Date.now();
      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pointsExpiryDays: 0,
              pointsExpiryMonths: 12,
              pointsExpiryWarningDays: 30,
              pointsExpiryLastChanceDays: 3,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );
      const requestCompletedAt = Date.now();

      expect(response.status).toBe(200);
      expect(prisma.weleticLoyaltyProgram.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            pointsExpiryDays: 0,
            pointsExpiryMonths: 12,
            pointsExpiryPolicyAnchorAt: expect.any(Date),
            pointsExpiryPolicyVersion: 8,
          }),
        }),
      );
      expect(policyRevisionMocks.publish).toHaveBeenCalledWith({
        tx: prisma,
        storeId: "store_expiry_settings",
        programId: "wprog_expiry_settings",
        reason: "loyalty_program_settings_updated",
      });
      const upsertInput = vi.mocked(prisma.weleticLoyaltyProgram.upsert).mock
        .calls[0]?.[0] as any;
      const anchorTimestamp =
        upsertInput.update.pointsExpiryPolicyAnchorAt.getTime();
      expect(anchorTimestamp).toBeGreaterThanOrEqual(requestStartedAt);
      expect(anchorTimestamp).toBeLessThanOrEqual(requestCompletedAt);
    });

    it("rejects ambiguous day-and-month windows", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_expiry_settings",
        projectId: "ws_tenant_a",
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pointsExpiryDays: 7,
              pointsExpiryMonths: 12,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });

    it("rejects out-of-range and non-numeric expiry values", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_expiry_settings",
        projectId: "ws_tenant_a",
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pointsExpiryMonths: 25 }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();

      const booleanResponse = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pointsExpiryMonths: false }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(booleanResponse.status).toBe(400);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });
  });

  describe("VIP Policy Settings", () => {
    it("persists the policy fields emitted by the VIP admin form", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_vip_settings",
        projectId: "ws_tenant_a",
        complianceState: "active",
        installationGeneration: "sgen_vip_settings",
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "wprog_vip_settings",
        storeId: "store_vip_settings",
        status: "active",
        killSwitchActive: false,
        pointsExpiryDays: 0,
        pointsExpiryMonths: 0,
        pointsExpiryWarningDays: 30,
        pointsExpiryLastChanceDays: 3,
        pointsExpiryWarningEnabled: true,
        pointsExpiryLastChanceEnabled: true,
        pointsExpiryPolicyAnchorAt: null,
        pointsExpiryPolicyVersion: 0,
      } as any);
      vi.mocked(prisma.weleticLoyaltyProgram.upsert).mockResolvedValue({
        id: "wprog_vip_settings",
      } as any);

      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              vipMilestoneMode: "points_earned",
              vipTimeframe: "lifetime",
              vipDowngradeGraceDays: 0,
              vipAutoDowngradeEnabled: false,
            }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      expect(prisma.weleticLoyaltyProgram.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            vipMilestoneMode: "points_earned",
            vipTimeframe: "lifetime",
            vipDowngradeGraceDays: 0,
            vipAutoDowngradeEnabled: false,
          }),
        }),
      );
    });

    it("rejects an unknown VIP milestone policy", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_vip_settings",
        projectId: "ws_tenant_a",
      } as any);
      const response = await postSettings(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/settings?workspaceId=ws_tenant_a",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vipTimeframe: "quarterly" }),
          },
        ) as any,
        { params: Promise.resolve({}) },
      );
      expect(response.status).toBe(400);
      expect(prisma.weleticLoyaltyProgram.upsert).not.toHaveBeenCalled();
    });
  });

  describe("Activity Ledger Contract and CSV Export", () => {
    it("returns the exact API shape consumed by the Activity tab", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            id: "wledger_contract_1",
            sequenceNumber: 7,
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
            pointsDelta: BigInt(125),
            pendingDelta: BigInt(25),
            balanceAfter: BigInt(900),
            referenceType: "shopify_order",
            referenceId: "order_1007",
            reason: "Order entered the holding period",
            createdAt: new Date("2026-09-01T10:00:00.000Z"),
            account: {
              shopper: {
                firstName: "Alice",
                lastName: "Smith",
                email: "alice@example.com",
              },
              currentTier: { name: "Silver VIP" },
            },
          },
        ] as any,
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.count).mockResolvedValueOnce(1);

      const response = await getActivity(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/activity?workspaceId=ws_tenant_a",
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const payload = await response.json();
      const entry = payload.data.entries[0];
      expect(entry).toMatchObject({
        pointsDelta: "125",
        pendingDelta: "25",
        balanceAfter: "900",
        reason: "Order entered the holding period",
        customer: {
          name: "Alice Smith",
          email: "alice@example.com",
        },
      });
      expect(toLoyaltyActivityTableRow(entry)).toEqual({
        pointsDelta: "125",
        pendingDelta: "25",
        balanceAfter: "900",
        customerName: "Alice Smith",
        customerEmail: "alice@example.com",
        notes: "Order entered the holding period",
      });
      expect(parseLoyaltyPointInteger("9007199254740993")).toEqual({
        state: "valid",
        value: BigInt("9007199254740993"),
      });
    });

    it.each([
      "",
      "01",
      "-0",
      "+1",
      "1.5",
      " 12",
      "12oops",
      "9223372036854775808",
      "-9223372036854775809",
    ])(
      "returns an explicit UI-safe invalid state for malformed ledger integer %j",
      (value) => {
        expect(parseLoyaltyPointInteger(value)).toEqual({
          state: "invalid",
          display: "Invalid",
        });
      },
    );

    it.each([
      ["=1+1", "'=1+1"],
      ["+SUM(A1:A2)", "'+SUM(A1:A2)"],
      ["-2+3", "'-2+3"],
      ["@SUM(A1:A2)", "'@SUM(A1:A2)"],
      ["＝1+1", "'＝1+1"],
      ["＋SUM(A1:A2)", "'＋SUM(A1:A2)"],
      ["－2+3", "'－2+3"],
      ["＠SUM(A1:A2)", "'＠SUM(A1:A2)"],
      ["\t=1+1", "'\t=1+1"],
      ["\r=1+1", '"\'\r=1+1"'],
    ])(
      "neutralizes untrusted CSV text beginning with a spreadsheet trigger",
      (value, expected) => {
        expect(escapeCsvUntrustedTextCell(value)).toBe(expected);
      },
    );

    it("preserves RFC CSV quoting after formula neutralization", () => {
      expect(escapeCsvUntrustedTextCell('=SUM("1,2")')).toBe(
        '"\'=SUM(""1,2"")"',
      );
      expect(escapeCsvUntrustedTextCell('Safe "quoted", value')).toBe(
        '"Safe ""quoted"", value"',
      );
    });

    it.each([
      "page=0",
      "page=-1",
      "page=1.5",
      "page=9007199254740992",
      "page=2147483649&limit=1",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "type=NOT_A_LEDGER_TYPE",
    ])("rejects invalid Activity query %s before Prisma", async (query) => {
      const response = await getActivity(
        new Request(
          `http://localhost/api/shopify/loyalty/admin/activity?workspaceId=ws_tenant_a&${query}`,
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "bad_request" },
      });
      expect(prisma.weleticShopifyStore.findUnique).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.findMany).not.toHaveBeenCalled();
    });

    it("accepts bounded pagination and an actual ledger enum value", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.count).mockResolvedValueOnce(0);

      const response = await getActivity(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/activity?workspaceId=ws_tenant_a&page=2&limit=100&type=TIER_BONUS",
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      expect(prisma.weleticPointsLedgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId: "store_yamax",
            entryType: WeleticPointsLedgerEntryType.TIER_BONUS,
          },
          skip: 100,
          take: 100,
        }),
      );
    });

    it("exports activity ledger in CSV format with RFC-compliant headers and escaping", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        projectId: "ws_tenant_a",
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            id: "wledger_1",
            sequenceNumber: 1,
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
            pointsDelta: BigInt("9007199254740993"),
            pendingDelta: BigInt("9007199254740995"),
            balanceAfter: BigInt("18014398509481988"),
            referenceType: "shopify_order",
            referenceId: "order_1001",
            reason: "Purchase on Store",
            createdAt: new Date("2026-08-15T10:00:00Z"),
            account: {
              shopper: {
                firstName: "Alice",
                lastName: "Smith",
                email: "alice@example.com",
              },
              currentTier: {
                name: "Silver VIP",
              },
            },
          },
          {
            id: "wledger_2",
            sequenceNumber: 2,
            entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
            pointsDelta: BigInt(-50),
            pendingDelta: BigInt("-9007199254740993"),
            balanceAfter: BigInt(50),
            referenceType: "reward_voucher",
            referenceId: "rew_discount",
            reason: '-Redeemed "¥500 Coupon, Special"',
            createdAt: new Date("2026-08-16T12:00:00Z"),
            account: {
              shopper: {
                firstName: "=Bob",
                lastName: "Jones",
                email: "+bob@example.com",
              },
              currentTier: {
                name: "@Bronze",
              },
            },
          },
        ] as any,
      );

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/activity?workspaceId=ws_tenant_a&format=csv",
      ) as any;
      const res = await getActivity(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("Content-Disposition")).toContain(
        "attachment; filename=",
      );

      const text = await res.text();
      expect(text).toContain(
        "Timestamp,Event Type,Customer Name,Email,Points Delta,Pending Delta,Balance After,Reference/Reason,VIP Tier",
      );
      expect(text).toContain(
        "EARN_ORDER,Alice Smith,alice@example.com,+9007199254740993,+9007199254740995,18014398509481988,Purchase on Store,Silver VIP",
      );
      expect(text).toContain(
        'REDEEM_REWARD,\'=Bob Jones,\'+bob@example.com,-50,-9007199254740993,50,"\'-Redeemed ""¥500 Coupon, Special""",\'@Bronze',
      );
      expect(text).not.toContain("'-50");
    });
  });

  describe("Admin Analytics & Financial Liability Engine (Milestone 3)", () => {
    it("returns financial liability, program health metrics, tier distribution, and referral economics", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        projectId: "ws_tenant_a",
        program: { accountingCurrency: "USD" },
        loyaltyProgram: null,
      } as any);

      // Mock loyalty accounts for liability, health metrics, and tier distribution
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        {
          id: "acc_1",
          currentTierId: "tier_gold",
          cachedPointsBalance: BigInt(500),
          cachedPendingPoints: BigInt(50),
          cachedRollingSpend: BigInt(50000),
          status: "active",
          updatedAt: new Date(),
          createdAt: new Date(),
        },
        {
          id: "acc_2",
          currentTierId: "tier_bronze",
          cachedPointsBalance: BigInt(1500),
          cachedPendingPoints: BigInt(0),
          cachedRollingSpend: BigInt(10000),
          status: "active",
          updatedAt: new Date(),
          createdAt: new Date(),
        },
      ] as any);

      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce({
        id: "prog_yamax",
        tiers: [],
      } as any);

      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce([
        {
          id: "ref_1",
          advocateAccountId: "acc_1",
          referredCustomerEmail: "friend@example.com",
          status: "completed",
          advocateRewardPointsDelta: 100,
          referredRewardValueMinor: 1000,
          firstOrderId: "ord_101",
          createdAt: new Date(),
        },
      ] as any);

      vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([
        {
          id: "tier_bronze",
          name: "Bronze VIP",
          tierOrder: 1,
          colorBadge: "bronze",
        },
        { id: "tier_gold", name: "Gold VIP", tierOrder: 2, colorBadge: "gold" },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(2000),
        },
        {
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(-500),
        },
        {
          entryType: WeleticPointsLedgerEntryType.EXPIRATION,
          pointsDelta: BigInt(-200),
        },
      ] as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/analytics?workspaceId=ws_tenant_a&currency=USD",
      ) as any;
      const res = await getAnalytics(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toBeDefined();
      const data = body.data;

      expect(data.storeId).toBe("store_yamax");
      expect(data.currency).toBe("USD");
      expect(data.liability).toBeDefined();
      expect(data.liability.totalCirculatingPoints).toBe("2000");
      expect(data.liability.totalPendingPoints).toBe("50");
      expect(data.liability.liabilityMinorUnitsNumerator).toBeNull();
      expect(data.liability.liabilityPointsDenominator).toBeNull();
      expect(data.liability.totalLiabilityMinorUnits).toBeNull();
      expect(data.summary.estimatedLiability).toBeNull();
      expect(data.financialMetrics).toEqual({
        status: "temporarily_unavailable",
        reason:
          "Configure liabilityValuationCurrency, liabilityMinorUnitsNumerator, and liabilityPointsDenominator before using monetary loyalty analytics.",
        liabilityStatus: "temporarily_unavailable",
        referralStatus: "temporarily_unavailable",
        accountingCurrency: "USD",
      });
      expect(data.referralEconomics.referralROI).toBeNull();
      expect(data.summary.totalPointsExpired).toBe("200");
      expect(data.health).toBeDefined();
      expect(data.tiers).toBeDefined();
      expect(data.referrals).toBeDefined();
    });

    it("returns 404 when store not connected to workspace", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(
        null,
      );

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/analytics?workspaceId=ws_tenant_a",
      ) as any;
      const res = await getAnalytics(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
    });

    it.each([
      ["startDate=not-a-date", /startDate must be a valid date/],
      [
        "startDate=2026-09-02T00%3A00%3A00Z&endDate=2026-09-01T00%3A00%3A00Z",
        /startDate must not be after endDate/,
      ],
    ])("rejects an invalid analytics date range (%s)", async (query, error) => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        program: { accountingCurrency: "USD" },
        loyaltyProgram: null,
      } as any);

      const response = await getAnalytics(
        new Request(
          `http://localhost/api/shopify/loyalty/admin/analytics?workspaceId=ws_tenant_a&${query}`,
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringMatching(error) },
      });
      expect(prisma.weleticLoyaltyAccount.findMany).not.toHaveBeenCalled();
    });

    it("exposes exact aggregate liability after valuation is configured", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yen",
        projectId: "ws_tenant_a",
        program: { accountingCurrency: "JPY" },
        loyaltyProgram: {
          liabilityValuationCurrency: "JPY",
          liabilityMinorUnitsNumerator: BigInt(1),
          liabilityPointsDenominator: BigInt(100),
        },
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        {
          id: "acc_yen_1",
          cachedPointsBalance: BigInt(50),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          id: "acc_yen_2",
          cachedPointsBalance: BigInt(50),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "program_yen",
        tiers: [],
      } as any);
      vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([]);

      const response = await getAnalytics(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/analytics?workspaceId=ws_tenant_a&currency=USD&valuationPerPointMinorUnits=999",
        ) as any,
        { params: Promise.resolve({}) },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.currency).toBe("JPY");
      expect(body.data.summary.estimatedLiability).toBe("1");
      expect(body.data.liability.totalLiabilityDecimal).toBe("1");
      expect(body.data.financialMetrics.status).toBe("available");
    });

    it("guards cohort and export routes to workspace owners", async () => {
      currentTestRole = "member";

      const cohortResponse = await getAnalyticsCohorts(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/analytics/cohorts?workspaceId=ws_tenant_a",
        ) as any,
        { params: Promise.resolve({}) },
      );
      const exportResponse = await getAnalyticsExport(
        new Request(
          "http://localhost/api/shopify/loyalty/admin/analytics/export?workspaceId=ws_tenant_a&format=json",
        ) as any,
        { params: Promise.resolve({}) },
      );

      expect(cohortResponse.status).toBe(403);
      expect(exportResponse.status).toBe(403);
      expect(prisma.weleticShopifyStore.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("Customer Accounts & Balance Adjustment (Milestone 3)", () => {
    it("returns mapped customer properties including shopper, customer, currentTier, and balance in data envelope", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_yamax",
        projectId: "ws_tenant_a",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          id: "acc_alice",
          storeId: "store_yamax",
          cachedPointsBalance: BigInt(750),
          cachedPendingPoints: BigInt(100),
          referralCode: "REF-ALICE",
          enrolledAt: new Date("2026-08-01"),
          shopper: {
            id: "shopper_1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@example.com",
          },
          currentTier: {
            id: "tier_silver",
            name: "Silver VIP",
          },
        },
      ] as any);
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValueOnce(1);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a",
      ) as any;
      const res = await getAccounts(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toBeDefined();
      const data = body.data;
      expect(data.accounts).toHaveLength(1);
      const acc = data.accounts[0];
      expect(acc.customer.firstName).toBe("Alice");
      expect(acc.shopper.firstName).toBe("Alice");
      expect(acc.currentTier.name).toBe("Silver VIP");
      expect(acc.balance).toBe("750");
      expect(acc.cachedPointsBalance).toBe("750");
    });

    it("applies points balance adjustment via POST /api/shopify/loyalty/admin/accounts with owner role", async () => {
      currentTestRole = "owner";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_yamax",
        projectId: "ws_tenant_a",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: "acc_bob",
        storeId: "store_yamax",
        status: "active",
        metadata: null,
        cachedPointsBalance: BigInt(300),
        cachedPendingPoints: BigInt(0),
        cachedRollingSpend: BigInt(15000),
        lifetimePointsEarned: BigInt(300),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 5,
        program: {
          tiers: [],
        },
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_bob",
        storeId: "store_yamax",
        cachedPointsBalance: BigInt(300),
        cachedPendingPoints: BigInt(0),
        cachedRollingSpend: BigInt(15000),
        lifetimePointsEarned: BigInt(300),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 5,
        program: {
          tiers: [],
        },
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findFirst).mockResolvedValue({
        sequenceNumber: 5,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValue({
        id: "entry_adj_99",
        accountId: "acc_bob",
        storeId: "store_yamax",
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        pointsDelta: BigInt(200),
        balanceAfter: BigInt(500),
        reason: "Customer Goodwill bonus",
        createdAt: new Date(),
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue({
        id: "acc_bob",
        cachedPointsBalance: BigInt(500),
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);

      vi.mocked(prisma.weleticCommerceOrder.aggregate).mockResolvedValue({
        _sum: { presentmentNet: BigInt(15000) },
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: "acc_bob",
            pointsDelta: 200,
            reason: "Customer Goodwill bonus",
          }),
        },
      ) as any;

      const res = await postAccounts(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(body.data.success).toBe(true);
      expect(body.data.pointsDelta).toBe("200");
      expect(body.data.newBalance).toBe("500");
    });
  });
});
