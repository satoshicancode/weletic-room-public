import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveStore: vi.fn(),
  findUniqueStore: vi.fn(),
  findFirstStore: vi.fn(),
  findUniqueOrder: vi.fn(),
  findUniqueRefund: vi.fn(),
  createRefund: vi.fn(),
  createRefundLines: vi.fn(),
  aggregateRefunds: vi.fn(),
  aggregateRefundLines: vi.fn(),
  aggregateCalculations: vi.fn(),
  updateOrder: vi.fn(),
  createCommission: vi.fn(),
  createCalculations: vi.fn(),
  acquiredLockKeys: [] as string[],
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: mocks.resolveStore,
  normalizeShopDomain: vi.fn((domain: string) =>
    domain ? domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "",
  ),
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ key, fn }) => {
    mocks.acquiredLockKeys.push(key);
    return fn();
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (cb) =>
      cb({
        weleticShopifyStore: { findUnique: mocks.findUniqueStore },
        weleticCommerceOrder: { update: mocks.updateOrder },
        weleticCommerceRefund: {
          create: mocks.createRefund,
          aggregate: mocks.aggregateRefunds,
        },
        weleticCommerceRefundLine: {
          createMany: mocks.createRefundLines,
          aggregate: mocks.aggregateRefundLines,
        },
        weleticCommissionCalculation: {
          createMany: mocks.createCalculations,
          aggregate: mocks.aggregateCalculations,
        },
        commission: { create: mocks.createCommission },
        weleticReviewRequest: { findMany: vi.fn().mockResolvedValue([]) },
        weleticLoyaltyEarnGrant: { findUnique: vi.fn().mockResolvedValue(null) },
        weleticLoyaltyReferral: { findFirst: vi.fn().mockResolvedValue(null) },
      }),
    ),
    weleticShopifyStore: {
      findUnique: mocks.findUniqueStore,
      findFirst: mocks.findFirstStore,
    },
    weleticCommerceOrder: { findUnique: mocks.findUniqueOrder },
    weleticCommerceRefund: { findUnique: mocks.findUniqueRefund },
    weleticLoyaltyAccount: { findMany: vi.fn().mockResolvedValue([]) },
    weleticLoyaltyReferral: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn().mockResolvedValue(undefined),
  assertShopifyStoreMatchesInstallationGeneration: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: vi.fn(async ({ fn }) => fn()),
  assertShopifySettlementLockContext: vi.fn(),
  shopifyCustomerSettlementLockKeys: vi.fn(() => []),
}));

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/weletic/loyalty/earn", () => ({
  processRefundPointsReversal: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/api/partners/sync-total-commissions", () => ({
  syncTotalCommissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/fx", () => ({
  persistFxQuote: vi.fn().mockResolvedValue({ id: "fx_snap_001" }),
}));

import { recordWeleticRefund } from "@/lib/weletic/commerce/record-refund";
import { shopifyOrderSettlementLockKey } from "@/lib/weletic/commerce/order-attribution";

describe("Adversarial Empirical Challenger: SYNC-01 Store Resolution & Tenancy Isolation", () => {
  const sampleRefundEvent = {
    id: 99887766,
    order_id: 11223344,
    created_at: "2026-10-05T01:00:00Z",
    processed_at: "2026-10-05T01:00:00Z",
    refund_line_items: [
      {
        id: 101,
        line_item_id: 201,
        quantity: 1,
        subtotal_set: {
          shop_money: {
            amount: "50.00",
            currency_code: "USD",
          },
        },
      },
    ],
    transactions: [],
    order_adjustments: [],
  };

  const createSampleStore = (storeId: string, workspaceId: string, domain: string) => ({
    id: storeId,
    projectId: workspaceId,
    programId: `prog_${workspaceId}`,
    shopDomain: domain,
    complianceState: "active",
  });

  const createSampleOrder = (storeId: string) => ({
    id: `word_${storeId}_123`,
    storeId,
    externalId: "11223344",
    status: "paid",
    orderName: "#1042",
    accountingNet: BigInt(5000),
    accountingCurrency: "USD",
    shopCurrency: "USD",
    presentmentCurrency: "USD",
    accountingFxRate: "1.0",
    lines: [
      {
        id: "wline_201",
        externalId: "201",
        accountingNet: BigInt(5000),
        commissionableAccountingAmount: BigInt(5000),
        shopGross: BigInt(5000),
        accountingCurrency: "USD",
        shopPrice: BigInt(5000),
        shopDiscount: BigInt(0),
        quantity: 1,
        calculations: [
          {
            id: "calc_001",
            partnerId: "partner_001",
            commissionId: "comm_001",
            ruleId: "rule_001",
            rateBasisPoints: 1000,
            earnings: BigInt(500),
            commissionableAmount: BigInt(5000),
            currency: "USD",
            entryType: "sale",
          },
        ],
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquiredLockKeys = [];

    // Direct findFirst on weleticShopifyStore MUST NOT be called for store resolution (Invariant 1)
    mocks.findFirstStore.mockImplementation(() => {
      throw new Error(
        "FAIL: Invariant 1 violation — Direct findFirst on weleticShopifyStore invoked during store resolution!",
      );
    });

    mocks.findUniqueRefund.mockResolvedValue(null);
    mocks.aggregateRefunds.mockResolvedValue({ _sum: { accountingAmount: BigInt(0) } });
    mocks.aggregateRefundLines.mockResolvedValue({ _sum: { accountingAmount: BigInt(0) } });
    mocks.aggregateCalculations.mockResolvedValue({ _sum: { earnings: BigInt(0) } });
    mocks.createRefund.mockResolvedValue({ id: "wref_created_001" });
    mocks.createRefundLines.mockResolvedValue({ count: 1 });
    mocks.createCalculations.mockResolvedValue({ count: 1 });
    mocks.createCommission.mockResolvedValue({ id: "comm_clawback_001" });
    mocks.updateOrder.mockImplementation(async (args) => args.data);
  });

  describe("Vector 1: Anti-Propagation of wstore_... (store.id) as workspaceId", () => {
    it("never propagates wstore_... into lock key or downstream queries when storeId is returned alongside canonical workspaceId", async () => {
      const canonicalWorkspace = "ws_enterprise_tenant_alpha";
      const internalStoreId = "wstore_internal_alpha_999";
      const domain = "alpha-store.myshopify.com";

      mocks.resolveStore.mockResolvedValueOnce({
        workspaceId: canonicalWorkspace,
        storeId: internalStoreId,
        shopId: "shop_alpha_123",
        primaryDomain: domain,
        myshopifyDomain: domain,
        allDomains: [domain],
        programId: "prog_alpha",
        accessToken: "shpat_test",
      });

      mocks.findUniqueStore.mockResolvedValueOnce(createSampleStore(internalStoreId, canonicalWorkspace, domain));
      mocks.findUniqueOrder.mockResolvedValueOnce(createSampleOrder(internalStoreId));

      await recordWeleticRefund({
        event: sampleRefundEvent,
        shopDomain: domain,
      });

      // 1. Lock key must strictly use canonical workspaceId, NEVER storeId
      expect(mocks.acquiredLockKeys).toHaveLength(1);
      expect(mocks.acquiredLockKeys[0]).toBe(`weletic:shopify:order:${canonicalWorkspace}:11223344`);
      expect(mocks.acquiredLockKeys[0]).not.toContain(internalStoreId);

      // 2. Downstream store lookup must strictly query { projectId: canonicalWorkspace }
      expect(mocks.findUniqueStore).toHaveBeenCalledWith({
        where: { projectId: canonicalWorkspace },
      });
      // Verify findUnique was NEVER called with internal storeId as projectId
      expect(mocks.findUniqueStore).not.toHaveBeenCalledWith({
        where: { projectId: internalStoreId },
      });
      expect(mocks.findUniqueStore).not.toHaveBeenCalledWith({
        where: { id: canonicalWorkspace },
      });
    });

    it("strictly rejects when resolver returns storeId but workspaceId is undefined", async () => {
      const internalStoreId = "wstore_poison_leak_666";
      const domain = "poison-tenant.myshopify.com";

      mocks.resolveStore.mockResolvedValueOnce({
        storeId: internalStoreId,
        workspaceId: undefined,
      });

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: domain,
        }),
      ).rejects.toThrow(`Shopify store ${domain} could not be resolved`);

      // Adversarial check: No lock acquired with poison storeId
      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });

    it("strictly rejects when resolver returns storeId but workspaceId is null", async () => {
      const internalStoreId = "wstore_null_leak_777";
      const domain = "null-tenant.myshopify.com";

      mocks.resolveStore.mockResolvedValueOnce({
        storeId: internalStoreId,
        workspaceId: null,
      });

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: domain,
        }),
      ).rejects.toThrow(`Shopify store ${domain} could not be resolved`);

      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });

    it("strictly rejects when resolver returns storeId but workspaceId is empty string", async () => {
      const internalStoreId = "wstore_empty_leak_888";
      const domain = "empty-tenant.myshopify.com";

      mocks.resolveStore.mockResolvedValueOnce({
        storeId: internalStoreId,
        workspaceId: "",
      });

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: domain,
        }),
      ).rejects.toThrow(`Shopify store ${domain} could not be resolved`);

      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });

    it("fails downstream if an adversarial resolver maliciously returned store.id as workspaceId", async () => {
      const internalStoreId = "wstore_malicious_id_999";
      const domain = "malicious.myshopify.com";

      // If a resolver erroneously or maliciously passed store.id as workspaceId
      mocks.resolveStore.mockResolvedValueOnce({
        storeId: internalStoreId,
        workspaceId: internalStoreId, // Malicious injection
      });

      // The database store record has projectId: "ws_real_tenant" (different from store.id)
      mocks.findUniqueStore.mockImplementation(async ({ where }) => {
        // Querying with where.projectId === internalStoreId finds nothing!
        if (where.projectId === internalStoreId) return null;
        return null;
      });

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: domain,
        }),
      ).rejects.toThrow(`Weletic Shopify store ${internalStoreId} was not synced.`);
    });
  });

  describe("Vector 2: Store Domain Aliases (myshopify vs primary vs custom domain) Resolution", () => {
    const canonicalWorkspace = "ws_omnichannel_brand";
    const storeId = "wstore_omnichannel_001";

    const aliasTestCases = [
      {
        name: "Standard technical myshopify domain",
        inputDomain: "brand-store.myshopify.com",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
      {
        name: "Renamed public myshopify alias",
        inputDomain: "brand-rebrand.myshopify.com",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
      {
        name: "Primary custom root domain",
        inputDomain: "brand.com",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
      {
        name: "Custom subdomain (e.g., checkout/store)",
        inputDomain: "shop.brand.com",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
      {
        name: "Regional ccTLD domain alias",
        inputDomain: "brand.jp",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
      {
        name: "Domain with https protocol prefix and trailing slash",
        inputDomain: "https://shop.brand.com/",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
      {
        name: "Domain with mixed-case and surrounding whitespace",
        inputDomain: "  SHOP.BRAND.COM  ",
        resolvedPayload: {
          workspaceId: canonicalWorkspace,
          storeId,
          primaryDomain: "brand.com",
          myshopifyDomain: "brand-store.myshopify.com",
        },
      },
    ];

    for (const tc of aliasTestCases) {
      it(`resolves ${tc.name} ('${tc.inputDomain}') to the canonical workspace`, async () => {
        mocks.resolveStore.mockResolvedValueOnce(tc.resolvedPayload);
        mocks.findUniqueStore.mockResolvedValueOnce(createSampleStore(storeId, canonicalWorkspace, "brand.com"));
        mocks.findUniqueOrder.mockResolvedValueOnce(createSampleOrder(storeId));

        const result = await recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: tc.inputDomain,
        });

        expect(mocks.resolveStore).toHaveBeenCalledWith(tc.inputDomain);
        expect(mocks.acquiredLockKeys).toHaveLength(1);
        expect(mocks.acquiredLockKeys[0]).toBe(`weletic:shopify:order:${canonicalWorkspace}:11223344`);
        expect(mocks.findUniqueStore).toHaveBeenCalledWith({
          where: { projectId: canonicalWorkspace },
        });
        expect(result.duplicate).toBe(false);
      });
    }
  });

  describe("Vector 3: Explicit Error Handling for Unresolvable Domains", () => {
    it("throws exact 'Shopify store ${domain} could not be resolved' when resolver returns null", async () => {
      const unknownDomain = "ghost-store.myshopify.com";
      mocks.resolveStore.mockResolvedValueOnce(null);

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: unknownDomain,
        }),
      ).rejects.toThrow(`Shopify store ${unknownDomain} could not be resolved`);

      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });

    it("throws exact error when resolver throws an unexpected network error", async () => {
      const domain = "network-fail.myshopify.com";
      mocks.resolveStore.mockRejectedValueOnce(new Error("Shopify Admin API timeout"));

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: domain,
        }),
      ).rejects.toThrow("Shopify Admin API timeout");

      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });

    it("throws exact error when resolver returns empty object without workspaceId", async () => {
      const domain = "corrupt-payload.myshopify.com";
      mocks.resolveStore.mockResolvedValueOnce({} as any);

      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: domain,
        }),
      ).rejects.toThrow(`Shopify store ${domain} could not be resolved`);

      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });

    it("throws exact error when called without workspaceId or shopDomain (bypassing TS types)", async () => {
      await expect(
        recordWeleticRefund({
          event: sampleRefundEvent,
        } as any),
      ).rejects.toThrow("Shopify store undefined could not be resolved");

      expect(mocks.acquiredLockKeys).toHaveLength(0);
      expect(mocks.findUniqueStore).not.toHaveBeenCalled();
    });
  });

  describe("Vector 4: Distributed Lock Key Scoping & Concurrency Isolation", () => {
    it("strictly isolates locks between two distinct tenants with identical order numbers", async () => {
      const orderNumber = 998877;
      const refundEvent = {
        ...sampleRefundEvent,
        order_id: orderNumber,
      };

      const tenantA = {
        workspaceId: "ws_tenant_apple",
        storeId: "wstore_apple_1",
        domain: "apple-store.myshopify.com",
      };
      const tenantB = {
        workspaceId: "ws_tenant_banana",
        storeId: "wstore_banana_2",
        domain: "banana-store.myshopify.com",
      };

      // Execution 1: Tenant A
      mocks.resolveStore.mockResolvedValueOnce({
        workspaceId: tenantA.workspaceId,
        storeId: tenantA.storeId,
      });
      mocks.findUniqueStore.mockResolvedValueOnce(createSampleStore(tenantA.storeId, tenantA.workspaceId, tenantA.domain));
      mocks.findUniqueOrder.mockResolvedValueOnce(createSampleOrder(tenantA.storeId));

      await recordWeleticRefund({
        event: refundEvent,
        shopDomain: tenantA.domain,
      });

      // Execution 2: Tenant B
      mocks.resolveStore.mockResolvedValueOnce({
        workspaceId: tenantB.workspaceId,
        storeId: tenantB.storeId,
      });
      mocks.findUniqueStore.mockResolvedValueOnce(createSampleStore(tenantB.storeId, tenantB.workspaceId, tenantB.domain));
      mocks.findUniqueOrder.mockResolvedValueOnce(createSampleOrder(tenantB.storeId));

      await recordWeleticRefund({
        event: refundEvent,
        shopDomain: tenantB.domain,
      });

      expect(mocks.acquiredLockKeys).toHaveLength(2);
      const lockA = mocks.acquiredLockKeys[0];
      const lockB = mocks.acquiredLockKeys[1];

      // Verification of lock key formula
      expect(lockA).toBe(shopifyOrderSettlementLockKey(tenantA.workspaceId, orderNumber));
      expect(lockB).toBe(shopifyOrderSettlementLockKey(tenantB.workspaceId, orderNumber));
      expect(lockA).toBe(`weletic:shopify:order:${tenantA.workspaceId}:${orderNumber}`);
      expect(lockB).toBe(`weletic:shopify:order:${tenantB.workspaceId}:${orderNumber}`);

      // Lock keys MUST NEVER collide between tenants
      expect(lockA).not.toBe(lockB);
    });

    it("normalizes order IDs formatted as Shopify Global ID (GID) into integer component", async () => {
      const workspaceId = "ws_gid_normalization_test";

      // Test helper directly for GID and string formats
      expect(shopifyOrderSettlementLockKey(workspaceId, "gid://shopify/Order/77665544")).toBe(
        `weletic:shopify:order:${workspaceId}:77665544`,
      );
      expect(shopifyOrderSettlementLockKey(workspaceId, 77665544)).toBe(
        `weletic:shopify:order:${workspaceId}:77665544`,
      );

      // And verify through recordWeleticRefund with standard Shopify webhook numeric order_id
      const numericOrderEvent = {
        ...sampleRefundEvent,
        order_id: 77665544,
      };
      const storeId = "wstore_gid_001";
      const domain = "gid-test.myshopify.com";

      mocks.resolveStore.mockResolvedValueOnce({
        workspaceId,
        storeId,
      });
      mocks.findUniqueStore.mockResolvedValueOnce(createSampleStore(storeId, workspaceId, domain));
      mocks.findUniqueOrder.mockResolvedValueOnce(createSampleOrder(storeId));

      await recordWeleticRefund({
        event: numericOrderEvent,
        shopDomain: domain,
      });

      expect(mocks.acquiredLockKeys).toHaveLength(1);
      expect(mocks.acquiredLockKeys[0]).toBe(`weletic:shopify:order:${workspaceId}:77665544`);
    });

    it("serializes multiple concurrent refunds for the same workspace and order under the identical lock key", async () => {
      const workspaceId = "ws_concurrent_settlement";
      const storeId = "wstore_concurrent_001";
      const domain = "concurrent.myshopify.com";
      const orderId = 55443322;

      const eventA = { ...sampleRefundEvent, id: 1001, order_id: orderId };
      const eventB = { ...sampleRefundEvent, id: 1002, order_id: orderId };

      mocks.resolveStore.mockResolvedValue({
        workspaceId,
        storeId,
      });
      mocks.findUniqueStore.mockResolvedValue(createSampleStore(storeId, workspaceId, domain));
      mocks.findUniqueOrder.mockResolvedValue(createSampleOrder(storeId));

      await Promise.all([
        recordWeleticRefund({ event: eventA, shopDomain: domain }),
        recordWeleticRefund({ event: eventB, shopDomain: domain }),
      ]);

      expect(mocks.acquiredLockKeys).toHaveLength(2);
      expect(mocks.acquiredLockKeys[0]).toBe(`weletic:shopify:order:${workspaceId}:${orderId}`);
      expect(mocks.acquiredLockKeys[1]).toBe(`weletic:shopify:order:${workspaceId}:${orderId}`);
      expect(mocks.acquiredLockKeys[0]).toBe(mocks.acquiredLockKeys[1]);
    });
  });

  describe("Vector 5: Zero-Hardcoding and Tenant Store Association Guard", () => {
    it("guarantees arbitrary dynamic workspace IDs are respected without hardcoding", async () => {
      const dynamicWorkspaceIds = [
        "ws_dynamic_uuid_4f7cd484-aefa-45ad-93e1-d721d5ffc47e",
        "ws_org_custom_987654321",
        "ws_tenant_test_12345",
      ];

      for (const dynamicWs of dynamicWorkspaceIds) {
        mocks.resolveStore.mockResolvedValueOnce({
          workspaceId: dynamicWs,
          storeId: `wstore_dyn_${dynamicWs}`,
        });
        mocks.findUniqueStore.mockResolvedValueOnce(
          createSampleStore(`wstore_dyn_${dynamicWs}`, dynamicWs, `${dynamicWs}.myshopify.com`),
        );
        mocks.findUniqueOrder.mockResolvedValueOnce(createSampleOrder(`wstore_dyn_${dynamicWs}`));

        await recordWeleticRefund({
          event: sampleRefundEvent,
          shopDomain: `${dynamicWs}.myshopify.com`,
        });

        expect(mocks.acquiredLockKeys.pop()).toBe(
          `weletic:shopify:order:${dynamicWs}:${sampleRefundEvent.order_id}`,
        );
        expect(mocks.findUniqueStore).toHaveBeenCalledWith({
          where: { projectId: dynamicWs },
        });
      }
    });
  });
});
