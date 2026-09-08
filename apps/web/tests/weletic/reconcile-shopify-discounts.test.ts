import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    discountCode: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticRewardRedemption: {
      findMany: vi.fn(),
    },
    weleticReconciliationIssue: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/get-installation", () => ({
  getWeleticShopifyInstallation: vi.fn(),
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

vi.mock("@/lib/api/links/cache", () => ({
  linkCache: {
    delete: vi.fn(),
  },
}));

import { linkCache } from "@/lib/api/links/cache";
import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";
import { getWeleticShopifyInstallation } from "@/lib/weletic/shopify/get-installation";

describe("Weletic Shopify Discount Reconciliation Engine", () => {
  const workspaceId = "ws_test_123";
  const storeId = "store_test_123";

  const mockStore = {
    id: storeId,
    projectId: workspaceId,
    programId: "prog_test_123",
    shopDomain: "yamaxdev.myshopify.com",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
    installationGeneration: "sgen_reconciliation_test",
    complianceState: "active",
    syncStatus: "succeeded",
  };

  const mockInstallation = {
    workspaceId,
    programId: "prog_test_123",
    shopDomain: "yamaxdev.myshopify.com",
    accessToken: "shpat_test_token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticShopifyStore.findFirst).mockResolvedValue(
      mockStore as any,
    );
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      ...mockStore,
      complianceState: "active",
    } as any);
    vi.mocked(prisma.weleticShopifyStore.update).mockResolvedValue(
      mockStore as any,
    );
    vi.mocked(getWeleticShopifyInstallation).mockResolvedValue(
      mockInstallation as any,
    );
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticReconciliationIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticReconciliationIssue.upsert).mockImplementation(((
      args: any,
    ) => Promise.resolve({ id: "wrecon_1", ...args.create })) as any);
    vi.mocked(prisma.weleticReconciliationIssue.updateMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(prisma.discountCode.updateMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(prisma.discountCode.findUnique).mockResolvedValue({
      disabledAt: new Date("2026-01-01T00:00:00.000Z"),
    } as any);
  });

  it("does not publish a stale reconciliation snapshot after store freeze", async () => {
    vi.mocked(prisma.weleticShopifyStore.findFirst).mockResolvedValueOnce({
      ...mockStore,
      complianceState: "frozen",
    } as any);
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      ...mockStore,
      complianceState: "frozen",
    } as any);
    vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
    vi.mocked(shopifyAdminGraphql).mockResolvedValue({
      codeDiscountNodes: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    } as any);

    await expect(
      reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
    ).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      complianceState: "frozen",
    });

    expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
    expect(prisma.weleticReconciliationIssue.updateMany).not.toHaveBeenCalled();
    expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
  });

  it.each([
    ["standalone", false],
    ["bulk redeem code", true],
  ])(
    "keeps stale %s cleanup report-only after freeze and reconnect",
    async (_kind, bulkParent) => {
      const oldGeneration = new Date("2026-08-30T00:00:00.000Z");
      const newGeneration = new Date("2026-08-30T01:00:00.000Z");
      vi.mocked(prisma.weleticShopifyStore.findFirst).mockResolvedValueOnce({
        ...mockStore,
        currencyVerifiedAt: oldGeneration,
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique)
        .mockResolvedValueOnce({
          ...mockStore,
          currencyVerifiedAt: oldGeneration,
        } as any)
        .mockResolvedValue({
          ...mockStore,
          currencyVerifiedAt: newGeneration,
        } as any);
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_generation_stale",
          code: "STALE_REMOTE_DELETE",
          programId: "prog_test_123",
          partnerId: "partner_stale",
          linkId: null,
          discountId: "disc_stale",
          disabledAt: new Date("2026-08-29T00:00:00.000Z"),
          discount: { id: "disc_stale", couponId: null },
          partner: { id: "partner_stale", name: "Hiro" },
          link: null,
        } as any,
      ]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/stale",
              codeDiscount: {
                title: "Dub Discount (STALE_REMOTE_DELETE)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/stale",
                      code: "STALE_REMOTE_DELETE",
                    },
                    ...(bulkParent
                      ? [
                          {
                            id: "gid://shopify/DiscountRedeemCode/other",
                            code: "OTHER_CODE",
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
          ],
        },
      } as any);
      const consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      try {
        await expect(
          reconcileWeleticShopifyDiscounts({
            workspaceId,
            autoHeal: true,
          }),
        ).rejects.toMatchObject({
          name: "ShopifyStoreOperationalWritesBlockedError",
          complianceState: "stale_currency_generation",
        });
      } finally {
        consoleWarn.mockRestore();
      }

      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
      expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledOnce();
      expect(
        prisma.weleticReconciliationIssue.updateMany,
      ).not.toHaveBeenCalled();
      expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
    },
  );

  it("does not publish reconciliation from an older installation generation", async () => {
    vi.mocked(prisma.weleticShopifyStore.findFirst).mockResolvedValueOnce({
      ...mockStore,
      installationGeneration: "sgen_reconciliation_old",
    } as any);
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      ...mockStore,
      installationGeneration: "sgen_reconciliation_new",
    } as any);
    vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
      {
        id: "dcode_stale_install",
        code: "STALE_INSTALL",
        programId: "prog_test_123",
        partnerId: "partner_stale_install",
        linkId: null,
        discountId: "disc_stale_install",
        disabledAt: null,
        discount: {
          id: "disc_stale_install",
          couponId: null,
          provider: "shopify",
        },
        partner: { id: "partner_stale_install", name: "Hiro" },
        link: null,
      } as any,
    ]);
    vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
      codeDiscountNodes: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    } as any);

    await expect(
      reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
    ).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      complianceState: "stale_installation_generation",
    });

    expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
    expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
    expect(linkCache.delete).not.toHaveBeenCalled();
    expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
  });

  describe("5-State Drift Detection & Reconciliation", () => {
    it("State 1: detects In-Sync discount codes and resolves open issues", async () => {
      // Setup DB: active discount code "SYNCED10"
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_1",
          code: "SYNCED10",
          programId: "prog_test_123",
          partnerId: "partner_1",
          linkId: "link_1",
          discountId: "disc_1",
          disabledAt: null,
          discount: { id: "disc_1", couponId: null },
          partner: { id: "partner_1", name: "Hiro" },
          link: { id: "link_1" },
        } as any,
      ]);

      // Setup Shopify: active discount code "SYNCED10"
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/101",
              codeDiscount: {
                title: "Dub Discount (SYNCED10)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/1",
                      code: "SYNCED10",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: false,
      });

      expect(result.driftStates.inSync).toBe(1);
      expect(result.driftStates.orphanedInWeletic).toBe(0);
      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.driftStates.statusDesyncShopifyActive).toBe(0);
      expect(result.driftStates.statusDesyncShopifyInactive).toBe(0);
      expect(result.openCount).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(prisma.discountCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            program: { workspaceId },
            discount: { provider: "shopify" },
          },
        }),
      );

      // Verifies resolution of any prior open issue
      expect(prisma.weleticReconciliationIssue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            storeId,
            externalKey: "SYNCED10",
          }),
        }),
      );
    });

    it("State 2: detects Orphaned in Weletic (Missing in Shopify) and auto-heals by disabling locally", async () => {
      // DB has active code with parent couponId "DEMO10"
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_2",
          code: "ORPHAN_DB",
          programId: "prog_test_123",
          partnerId: "partner_2",
          linkId: "link_2",
          discountId: "disc_2",
          disabledAt: null,
          updatedAt: new Date("2026-08-29T02:00:00.000Z"),
          discount: { id: "disc_2", couponId: "DEMO10" },
          partner: { id: "partner_2", name: "Hiro" },
          link: {
            id: "link_2",
            domain: "shop.example.com",
            key: "orphan-db",
          },
        } as any,
      ]);

      // Shopify has 0 nodes matching ORPHAN_DB
      vi.mocked(shopifyAdminGraphql)
        // 1. Initial reconciliation query
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInWeletic).toBe(1);
      expect(result.healedCount).toBe(1);
      expect(result.issues[0]).toMatchObject({
        code: "ORPHAN_DB",
        kind: "discount_missing_in_shopify",
        severity: "critical",
        driftState: "orphaned_in_weletic",
        healed: true,
        healingAction: "disabled_in_db_missing_in_shopify",
      });

      expect(prisma.discountCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "dcode_2",
            code: "ORPHAN_DB",
            disabledAt: null,
            updatedAt: new Date("2026-08-29T02:00:00.000Z"),
          },
          data: expect.objectContaining({ disabledAt: expect.any(Date) }),
        }),
      );
      expect(linkCache.delete).toHaveBeenCalledWith({
        domain: "shop.example.com",
        key: "orphan-db",
      });
    });

    it("State 2: detects Orphaned in Weletic (Missing in Shopify) without parent discount and auto-heals by disabling in DB", async () => {
      // DB has standalone active code (no couponId)
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_3",
          code: "STANDALONE_ORPHAN",
          programId: "prog_test_123",
          partnerId: "partner_3",
          linkId: "link_3",
          discountId: "disc_3",
          disabledAt: null,
          updatedAt: new Date("2026-08-29T03:00:00.000Z"),
          discount: { id: "disc_3", couponId: null },
          partner: { id: "partner_3", name: "Hiro" },
          link: { id: "link_3" },
        } as any,
      ]);

      // Shopify empty
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInWeletic).toBe(1);
      expect(result.healedCount).toBe(1);
      expect(result.issues[0].healingAction).toBe(
        "disabled_in_db_missing_in_shopify",
      );

      expect(prisma.discountCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "dcode_3",
            code: "STANDALONE_ORPHAN",
            disabledAt: null,
            updatedAt: new Date("2026-08-29T03:00:00.000Z"),
          },
          data: expect.objectContaining({ disabledAt: expect.any(Date) }),
        }),
      );
    });

    it("does not disable a code created after the eligible local snapshot", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.scannedCount).toBe(0);
      expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
      expect(
        vi.mocked(prisma.discountCode.findMany).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(shopifyAdminGraphql).mock.invocationCallOrder[0]!,
      );
    });

    it("uses the exact local snapshot CAS before disabling a missing remote code", async () => {
      const snapshotUpdatedAt = new Date("2026-08-29T03:30:00.000Z");
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_reactivated",
          code: "REACTIVATED_AFTER_SCAN",
          programId: "prog_test_123",
          partnerId: "partner_reactivated",
          linkId: "link_reactivated",
          discountId: "disc_reactivated",
          disabledAt: null,
          updatedAt: snapshotUpdatedAt,
          discount: { id: "disc_reactivated", couponId: null },
          partner: { id: "partner_reactivated", name: "Hiro" },
          link: {
            id: "link_reactivated",
            domain: "shop.example.com",
            key: "reactivated-after-scan",
          },
        } as any,
      ]);
      vi.mocked(prisma.discountCode.updateMany).mockResolvedValueOnce({
        count: 0,
      } as any);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(prisma.discountCode.updateMany).toHaveBeenCalledWith({
        where: {
          id: "dcode_reactivated",
          code: "REACTIVATED_AFTER_SCAN",
          disabledAt: null,
          updatedAt: snapshotUpdatedAt,
        },
        data: { disabledAt: expect.any(Date) },
      });
      expect(result.healedCount).toBe(0);
      expect(result.openCount).toBe(1);
      expect(linkCache.delete).not.toHaveBeenCalled();
    });

    it("does not infer ownership for an unmatched merchant-added bulk sibling", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_parent_anchor",
          code: "PARENT_ANCHOR",
          programId: "prog_test_123",
          partnerId: "partner_anchor",
          linkId: null,
          discountId: "disc_parent",
          disabledAt: null,
          discount: {
            id: "disc_parent",
            couponId: "gid://shopify/DiscountCodeNode/303",
            provider: "shopify",
          },
          partner: { id: "partner_anchor", name: "Hiro" },
          link: null,
        } as any,
      ]);

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/303",
              codeDiscount: {
                title: "Dub bulk discount",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/anchor",
                      code: "PARENT_ANCHOR",
                    },
                    {
                      id: "gid://shopify/DiscountRedeemCode/orphan",
                      code: "MERCHANT_SIBLING",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.inSync).toBe(1);
      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.healedCount).toBe(0);
      expect(result.manualCleanupCount).toBe(0);
      expect(result.openCount).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("does not classify an unmanaged standalone Shopify discount from its title or node shape", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/merchant",
              codeDiscount: {
                title: "Weletic summer promotion",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/merchant",
                      code: "MERCHANT20",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.healedCount).toBe(0);
      expect(result.manualCleanupCount).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("resolves an earlier managed-orphan issue only after a full scan no longer observes it", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticReconciliationIssue.findMany).mockResolvedValue([
        {
          id: "wrecon_persisted_orphan",
          externalKey: "ORPHAN_SHOPIFY",
          kind: "discount_orphaned_in_shopify",
          severity: "warning",
          details: {
            requiresManualCleanup: true,
            ownershipEvidence: {
              source: "discount_code_row",
              discountCodeId: "dcode_deleted",
              discountId: "disc_deleted",
              programId: "prog_test_123",
              provider: "shopify",
            },
          },
        } as any,
      ]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.manualCleanupCount).toBe(0);
      expect(prisma.weleticReconciliationIssue.updateMany).toHaveBeenCalledWith(
        {
          where: {
            id: "wrecon_persisted_orphan",
            storeId,
            status: "open",
          },
          data: {
            status: "resolved",
            resolvedAt: expect.any(Date),
          },
        },
      );
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("keeps a persisted managed-orphan issue open when its local anchor disappeared but the exact remote code is active", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_replacement_same_text",
          code: "ORPHAN_SHOPIFY",
          programId: "prog_test_123",
          partnerId: "partner_replacement",
          linkId: null,
          discountId: "disc_replacement",
          disabledAt: null,
          updatedAt: new Date("2026-08-30T00:30:00.000Z"),
          discount: {
            id: "disc_replacement",
            couponId: null,
            provider: "shopify",
          },
          partner: { id: "partner_replacement", name: "Replacement" },
          link: null,
        } as any,
      ]);
      vi.mocked(prisma.weleticReconciliationIssue.findMany).mockResolvedValue([
        {
          id: "wrecon_active_orphan",
          externalKey: "ORPHAN_SHOPIFY",
          kind: "discount_orphaned_in_shopify",
          severity: "warning",
          details: {
            requiresManualCleanup: true,
            cleanupMode: "manual_verified_shopify_cleanup",
            ownershipEvidence: {
              source: "discount_code_row",
              discountCodeId: "dcode_deleted",
              discountId: "disc_deleted",
              programId: "prog_test_123",
              provider: "shopify",
              shopifyNodeId: "gid://shopify/DiscountCodeNode/303",
              shopifyRedeemCodeId: "gid://shopify/DiscountRedeemCode/orphan",
            },
          },
        } as any,
      ]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/303",
              codeDiscount: {
                title: "Former Weletic bulk discount",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/orphan",
                      code: "ORPHAN_SHOPIFY",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInShopify).toBe(1);
      expect(result.manualCleanupCount).toBe(1);
      expect(result.openCount).toBe(1);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          id: "wrecon_active_orphan",
          code: "ORPHAN_SHOPIFY",
          driftState: "orphaned_in_shopify",
          healed: false,
        }),
      );
      expect(
        prisma.weleticReconciliationIssue.updateMany,
      ).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "wrecon_active_orphan" }),
        }),
      );
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("does not carry ownership across a merchant replacement that reuses the same code text", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticReconciliationIssue.findMany).mockResolvedValue([
        {
          id: "wrecon_replaced_orphan",
          externalKey: "REUSED_CODE",
          kind: "discount_orphaned_in_shopify",
          severity: "warning",
          details: {
            requiresManualCleanup: true,
            ownershipEvidence: {
              source: "discount_code_row",
              discountCodeId: "dcode_deleted",
              discountId: "disc_deleted",
              programId: "prog_test_123",
              provider: "shopify",
              shopifyNodeId: "gid://shopify/DiscountCodeNode/old",
              shopifyRedeemCodeId: "gid://shopify/DiscountRedeemCode/old",
            },
          },
        } as any,
      ]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/merchant-replacement",
              codeDiscount: {
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/merchant-replacement",
                      code: "REUSED_CODE",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.manualCleanupCount).toBe(0);
      expect(result.openCount).toBe(0);
      expect(prisma.weleticReconciliationIssue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "wrecon_replaced_orphan" }),
          data: expect.objectContaining({ status: "resolved" }),
        }),
      );
    });

    it("carries a status-desync issue after the local anchor disappears only for the exact active remote identity", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticReconciliationIssue.findMany).mockResolvedValue([
        {
          id: "wrecon_status_desync",
          externalKey: "DISABLED_REMOTE_ACTIVE",
          kind: "discount_status_desync",
          severity: "warning",
          details: {
            requiresManualCleanup: true,
            ownershipEvidence: {
              source: "discount_code_row",
              discountCodeId: "dcode_deleted",
              discountId: "disc_deleted",
              programId: "prog_test_123",
              provider: "shopify",
              shopifyNodeId: "gid://shopify/DiscountCodeNode/status",
              shopifyRedeemCodeId: "gid://shopify/DiscountRedeemCode/status",
            },
          },
        } as any,
      ]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/status",
              codeDiscount: {
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/status",
                      code: "DISABLED_REMOTE_ACTIVE",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.statusDesyncShopifyActive).toBe(1);
      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.manualCleanupCount).toBe(1);
      expect(result.openCount).toBe(1);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          id: "wrecon_status_desync",
          kind: "discount_status_desync",
          driftState: "status_desync_shopify_active",
        }),
      );
    });

    it("does not classify a remote sibling from legacy parent-only ownership evidence", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticReconciliationIssue.findMany).mockResolvedValue([
        {
          id: "wrecon_unsafe_parent_evidence",
          externalKey: "MERCHANT_SIBLING",
          kind: "discount_orphaned_in_shopify",
          severity: "warning",
          details: {
            requiresManualCleanup: true,
            ownershipEvidence: {
              source: "discount_parent_coupon_id",
              discountId: "disc_parent",
              programId: "prog_test_123",
              couponId: "gid://shopify/DiscountCodeNode/303",
            },
          },
        } as any,
      ]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/303",
              codeDiscount: {
                title: "Shared bulk discount",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/sibling",
                      code: "MERCHANT_SIBLING",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.manualCleanupCount).toBe(0);
      expect(result.openCount).toBe(1);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          id: "wrecon_unsafe_parent_evidence",
          details: expect.objectContaining({
            requiresManualCleanup: false,
            cleanupMode: "ownership_verification_required",
            ownershipVerificationRequired: true,
          }),
        }),
      );
      expect(prisma.weleticReconciliationIssue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "wrecon_unsafe_parent_evidence",
          }),
          data: expect.objectContaining({
            details: expect.objectContaining({
              ownershipVerificationRequired: true,
            }),
            resolvedAt: null,
          }),
        }),
      );
    });

    it("ignores an unmatched loyalty voucher without inferring ownership from its title", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/606",
              codeDiscount: {
                title: "[STAGING] Free Yamax Flow Shorts (WL-BASIC-FREE-0828)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/606",
                      code: "ｗｌ－ｂａｓｉｃ－ｆｒｅｅ－０８２８",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(prisma.weleticRewardRedemption.findMany).not.toHaveBeenCalled();
      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.healedCount).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("State 4: keeps an owned active Shopify code open for verified manual cleanup", async () => {
      // DB has disabled code
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_4",
          code: "DISABLED_IN_DB",
          programId: "prog_test_123",
          partnerId: "partner_4",
          linkId: "link_4",
          discountId: "disc_4",
          disabledAt: new Date("2026-01-01T00:00:00Z"),
          discount: { id: "disc_4", couponId: null, provider: "shopify" },
          partner: { id: "partner_4", name: "Hiro" },
          link: { id: "link_4" },
        } as any,
      ]);

      // Shopify still has active node
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/404",
              codeDiscount: {
                title: "Dub Discount (DISABLED_IN_DB)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/404",
                      code: "DISABLED_IN_DB",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.statusDesyncShopifyActive).toBe(1);
      expect(result.healedCount).toBe(0);
      expect(result.manualCleanupCount).toBe(1);
      expect(result.openCount).toBe(1);
      expect(result.issues[0]).toMatchObject({
        code: "DISABLED_IN_DB",
        kind: "discount_status_desync",
        severity: "warning",
        driftState: "status_desync_shopify_active",
        healed: false,
        details: {
          requiresManualCleanup: true,
          cleanupMode: "manual_verified_shopify_cleanup",
          ownershipEvidence: {
            source: "discount_code_row",
            discountCodeId: "dcode_4",
            discountId: "disc_4",
            programId: "prog_test_123",
            provider: "shopify",
            shopifyNodeId: "gid://shopify/DiscountCodeNode/404",
            shopifyRedeemCodeId: "gid://shopify/DiscountRedeemCode/404",
          },
        },
      });
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("State 5: detects Status Desync (Active in DB, Inactive/Expired in Shopify) and auto-heals by disabling in DB", async () => {
      // DB has active code
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_5",
          code: "EXPIRED_ON_SHOPIFY",
          programId: "prog_test_123",
          partnerId: "partner_5",
          linkId: "link_5",
          discountId: "disc_5",
          disabledAt: null,
          updatedAt: new Date("2026-08-29T05:00:00.000Z"),
          discount: { id: "disc_5", couponId: null },
          partner: { id: "partner_5", name: "Hiro" },
          link: { id: "link_5" },
        } as any,
      ]);

      // Shopify has node with EXPIRED status
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/505",
              codeDiscount: {
                title: "Dub Discount (EXPIRED_ON_SHOPIFY)",
                status: "EXPIRED",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/505",
                      code: "EXPIRED_ON_SHOPIFY",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(result.driftStates.statusDesyncShopifyInactive).toBe(1);
      expect(result.healedCount).toBe(1);
      expect(result.issues[0]).toMatchObject({
        code: "EXPIRED_ON_SHOPIFY",
        kind: "discount_status_desync",
        severity: "warning",
        driftState: "status_desync_shopify_inactive",
        healed: true,
        healingAction: "disabled_in_db_expired_in_shopify",
      });

      expect(prisma.discountCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "dcode_5",
            code: "EXPIRED_ON_SHOPIFY",
            disabledAt: null,
            updatedAt: new Date("2026-08-29T05:00:00.000Z"),
          },
          data: expect.objectContaining({ disabledAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe("GraphQL Cursor Pagination Across Multiple Discount Types", () => {
    it("paginates through multiple pages with Basic, Bxgy, FreeShipping, and App nodes", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);

      // Page 1: Basic & Bxgy nodes
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: true, endCursor: "cursor_page_1" },
            nodes: [
              {
                id: "gid://shopify/DiscountCodeNode/1",
                codeDiscount: {
                  title: "Dub Discount (BASIC_CODE)",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "gid://shopify/DiscountRedeemCode/1",
                        code: "BASIC_CODE",
                      },
                    ],
                  },
                },
              },
              {
                id: "gid://shopify/DiscountCodeNode/2",
                codeDiscount: {
                  title: "Dub Discount (BXGY_CODE)",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "gid://shopify/DiscountRedeemCode/2",
                        code: "BXGY_CODE",
                      },
                    ],
                  },
                },
              },
            ],
          },
        } as any)
        // Page 2: FreeShipping & App nodes
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/DiscountCodeNode/3",
                codeDiscount: {
                  title: "Dub Discount (SHIPPING_CODE)",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "gid://shopify/DiscountRedeemCode/3",
                        code: "SHIPPING_CODE",
                      },
                    ],
                  },
                },
              },
              {
                id: "gid://shopify/DiscountCodeNode/4",
                codeDiscount: {
                  title: "Dub Discount (APP_CODE)",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "gid://shopify/DiscountRedeemCode/4",
                        code: "APP_CODE",
                      },
                    ],
                  },
                },
              },
            ],
          },
        } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: false,
      });

      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(2);
      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.issues).toHaveLength(0);
    });

    it("paginates beyond 250 nested redeem codes before deciding managed local state", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([
        {
          id: "dcode_page_2",
          code: "PAGE_2_MANAGED",
          programId: "prog_test_123",
          partnerId: "partner_page_2",
          linkId: "link_page_2",
          discountId: "disc_page_2",
          disabledAt: null,
          discount: {
            id: "disc_page_2",
            couponId: "gid://shopify/DiscountCodeNode/bulk-251",
            provider: "shopify",
          },
          partner: { id: "partner_page_2", name: "Hiro" },
          link: {
            id: "link_page_2",
            domain: "shop.example.com",
            key: "page-2-managed",
          },
        } as any,
      ]);
      const firstPageCodes = Array.from({ length: 250 }, (_, index) => ({
        id: `gid://shopify/DiscountRedeemCode/filler-${index}`,
        code: `FILLER_${index}`,
      }));
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/DiscountCodeNode/bulk-251",
                codeDiscount: {
                  title: "Bulk discount",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "nested_cursor_250",
                    },
                    nodes: firstPageCodes,
                  },
                },
              },
            ],
          },
        } as any)
        .mockResolvedValueOnce({
          codeDiscountNode: {
            codeDiscount: {
              codes: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "gid://shopify/DiscountRedeemCode/managed-251",
                    code: "PAGE_2_MANAGED",
                  },
                ],
              },
            },
          },
        } as any);

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId,
        autoHeal: true,
      });

      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(2);
      expect(shopifyAdminGraphql).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          query: expect.stringContaining("WeleticDiscountRedeemCodesPage"),
          variables: {
            id: "gid://shopify/DiscountCodeNode/bulk-251",
            after: "nested_cursor_250",
          },
        }),
      );
      expect(result.driftStates.inSync).toBe(1);
      expect(result.driftStates.orphanedInWeletic).toBe(0);
      expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
      expect(linkCache.delete).not.toHaveBeenCalled();
    });

    it("fails closed before DB publication when a nested redeem-code page cursor is incomplete", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/incomplete",
              codeDiscount: {
                title: "Incomplete bulk discount",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: true, endCursor: null },
                  nodes: [],
                },
              },
            },
          ],
        },
      } as any);

      await expect(
        reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
      ).rejects.toThrow("invalid nested cursor");

      expect(prisma.discountCode.findMany).toHaveBeenCalledOnce();
      expect(prisma.weleticReconciliationIssue.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
      expect(
        prisma.weleticReconciliationIssue.updateMany,
      ).not.toHaveBeenCalled();
      expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
      expect(linkCache.delete).not.toHaveBeenCalled();
    });

    it("fails closed before DB publication when nested pageInfo is missing", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/missing-page-info",
              codeDiscount: {
                status: "ACTIVE",
                codes: {
                  nodes: [
                    {
                      id: "gid://shopify/DiscountRedeemCode/missing-page-info",
                      code: "MISSING_PAGE_INFO",
                    },
                  ],
                },
              },
            },
          ],
        },
      } as any);

      await expect(
        reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
      ).rejects.toThrow("nested pageInfo unavailable");

      expect(prisma.discountCode.findMany).toHaveBeenCalledOnce();
      expect(prisma.weleticReconciliationIssue.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
      expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
    });

    it("fails closed before DB publication when top-level pageInfo is missing", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: { nodes: [] },
      } as any);

      await expect(
        reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
      ).rejects.toThrow("top-level pageInfo unavailable");

      expect(prisma.discountCode.findMany).toHaveBeenCalledOnce();
      expect(prisma.weleticReconciliationIssue.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
      expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        "top-level nodes are missing",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        "top-level nodes unavailable",
      ],
      [
        "top-level hasNextPage is missing",
        {
          pageInfo: { endCursor: null },
          nodes: [],
        },
        "top-level hasNextPage unavailable",
      ],
      [
        "a top-level node has no complete identity",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "node_malformed", codeDiscount: null }],
        },
        "malformed top-level discount node",
      ],
      [
        "a discount status is whitespace",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "node_blank_status",
              codeDiscount: {
                status: "   ",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          ],
        },
        "status unavailable",
      ],
      [
        "a discount status is unknown",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "node_unknown_status",
              codeDiscount: {
                status: "PAUSED",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          ],
        },
        "unsupported status 'PAUSED'",
      ],
      [
        "a discount status is outside Shopify's exact enum",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "node_inactive_status",
              codeDiscount: {
                status: "INACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          ],
        },
        "unsupported status 'INACTIVE'",
      ],
      [
        "nested nodes are missing",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "node_nested_missing",
              codeDiscount: {
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          ],
        },
        "nested nodes unavailable",
      ],
      [
        "nested hasNextPage is missing",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "node_nested_page_info",
              codeDiscount: {
                status: "ACTIVE",
                codes: {
                  pageInfo: { endCursor: null },
                  nodes: [],
                },
              },
            },
          ],
        },
        "nested hasNextPage unavailable",
      ],
      [
        "a redeem code has no complete identity",
        {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "node_bad_redeem",
              codeDiscount: {
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ id: "", code: "BAD_REDEEM" }],
                },
              },
            },
          ],
        },
        "redeem-code identity unavailable",
      ],
    ])(
      "fails closed before DB publication when %s",
      async (_scenario, codeDiscountNodes, expectedError) => {
        vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          codeDiscountNodes,
        } as any);

        await expect(
          reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
        ).rejects.toThrow(expectedError);

        expect(prisma.discountCode.findMany).toHaveBeenCalledOnce();
        expect(
          prisma.weleticReconciliationIssue.findMany,
        ).not.toHaveBeenCalled();
        expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
        expect(
          prisma.weleticReconciliationIssue.updateMany,
        ).not.toHaveBeenCalled();
        expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
        expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
        expect(linkCache.delete).not.toHaveBeenCalled();
      },
    );

    it("fails closed on an empty terminal nested continuation page", async () => {
      vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/DiscountCodeNode/empty-terminal",
                codeDiscount: {
                  status: "ACTIVE",
                  codes: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "nested_terminal_cursor",
                    },
                    nodes: [
                      {
                        id: "gid://shopify/DiscountRedeemCode/first",
                        code: "FIRST_CODE",
                      },
                    ],
                  },
                },
              },
            ],
          },
        } as any)
        .mockResolvedValueOnce({
          codeDiscountNode: {
            codeDiscount: {
              codes: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        } as any);

      await expect(
        reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
      ).rejects.toThrow("empty nested continuation page");

      expect(prisma.discountCode.findMany).toHaveBeenCalledOnce();
      expect(prisma.weleticReconciliationIssue.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
      expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        "missing cursor",
        null,
        [{ id: "node_1", codeDiscount: null }],
        "invalid top-level cursor",
      ],
      ["empty page", "cursor_page_2", [], "empty top-level continuation page"],
      [
        "repeated cursor",
        "cursor_page_1",
        [{ id: "node_1", codeDiscount: null }],
        "invalid top-level cursor",
      ],
      ["empty terminal page", null, [], "empty top-level continuation page"],
    ])(
      "fails closed before DB publication for a top-level %s",
      async (scenario, endCursor, nodes, expectedError) => {
        const completeNode = (id: string) => ({
          id,
          codeDiscount: {
            status: "ACTIVE",
            codes: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: `gid://shopify/DiscountRedeemCode/${id}`,
                  code: `CODE_${id}`,
                },
              ],
            },
          },
        });
        const completeNodes = (nodes as Array<any>).map((node) =>
          node?.codeDiscount === null ? completeNode(node.id) : node,
        );
        vi.mocked(prisma.discountCode.findMany).mockResolvedValue([]);
        vi.mocked(shopifyAdminGraphql)
          .mockResolvedValueOnce({
            codeDiscountNodes: {
              pageInfo: { hasNextPage: true, endCursor: "cursor_page_1" },
              nodes: [completeNode("node_0")],
            },
          } as any)
          .mockResolvedValueOnce({
            codeDiscountNodes: {
              pageInfo: {
                hasNextPage: scenario !== "empty terminal page",
                endCursor,
              },
              nodes: completeNodes,
            },
          } as any);

        if (scenario === "missing cursor") {
          vi.mocked(shopifyAdminGraphql).mockReset();
          vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
            codeDiscountNodes: {
              pageInfo: { hasNextPage: true, endCursor },
              nodes: completeNodes,
            },
          } as any);
        }

        await expect(
          reconcileWeleticShopifyDiscounts({ workspaceId, autoHeal: true }),
        ).rejects.toThrow(expectedError);

        expect(prisma.discountCode.findMany).toHaveBeenCalledOnce();
        expect(
          prisma.weleticReconciliationIssue.findMany,
        ).not.toHaveBeenCalled();
        expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
        expect(
          prisma.weleticReconciliationIssue.updateMany,
        ).not.toHaveBeenCalled();
        expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
        expect(prisma.weleticShopifyStore.update).not.toHaveBeenCalled();
        expect(linkCache.delete).not.toHaveBeenCalled();
      },
    );
  });

  describe("Error Handling & Distributed Locking", () => {
    it("throws an error when WeleticShopifyStore is not found", async () => {
      vi.mocked(prisma.weleticShopifyStore.findFirst).mockResolvedValueOnce(
        null,
      );

      await expect(
        reconcileWeleticShopifyDiscounts({
          workspaceId: "non_existent_ws",
        }),
      ).rejects.toThrow("WeleticShopifyStore not found");
    });
  });
});
