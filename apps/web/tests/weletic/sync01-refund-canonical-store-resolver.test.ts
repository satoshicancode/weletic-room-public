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
  lastAcquiredLockKey: null as string | null,
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: mocks.resolveStore,
  normalizeShopDomain: vi.fn((domain: string) =>
    domain ? domain.trim().toLowerCase() : null,
  ),
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ key, fn }) => {
    mocks.lastAcquiredLockKey = key;
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

describe("SYNC-01: Canonical Store Resolver in record-refund.ts (Invariant 1 Compliance)", () => {
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

  const sampleStore = {
    id: "wstore_yamax_001",
    projectId: "ws_yamax_canonical",
    programId: "prog_yamax_001",
    shopDomain: "yamaxdev.myshopify.com",
    complianceState: "active",
  };

  const sampleOrder = {
    id: "word_123",
    storeId: "wstore_yamax_001",
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lastAcquiredLockKey = null;

    // Fail immediately if direct findFirst on weleticShopifyStore is invoked for store resolution
    mocks.findFirstStore.mockImplementation(() => {
      throw new Error(
        "Direct findFirst on weleticShopifyStore is strictly prohibited by Invariant 1!",
      );
    });

    mocks.findUniqueRefund.mockResolvedValue(null);
    mocks.findUniqueOrder.mockResolvedValue(sampleOrder);
    mocks.findUniqueStore.mockResolvedValue(sampleStore);
    mocks.aggregateRefunds.mockResolvedValue({ _sum: { accountingAmount: BigInt(0) } });
    mocks.aggregateRefundLines.mockResolvedValue({ _sum: { accountingAmount: BigInt(0) } });
    mocks.aggregateCalculations.mockResolvedValue({ _sum: { earnings: BigInt(0) } });
    mocks.createRefund.mockResolvedValue({ id: "wref_created_001" });
    mocks.createRefundLines.mockResolvedValue({ count: 1 });
    mocks.createCalculations.mockResolvedValue({ count: 1 });
    mocks.createCommission.mockResolvedValue({ id: "comm_clawback_001" });
    mocks.updateOrder.mockResolvedValue(sampleOrder);
  });

  it("1. Resolves store strictly via resolveShopifyStoreByDomain when shopDomain is provided", async () => {
    mocks.resolveStore.mockResolvedValueOnce({
      workspaceId: "ws_yamax_canonical",
      storeId: "wstore_yamax_001",
      shopId: "shop_123",
      primaryDomain: "yamaxdev.myshopify.com",
      myshopifyDomain: "yamaxdev.myshopify.com",
      allDomains: ["yamaxdev.myshopify.com"],
      programId: "prog_yamax_001",
      accessToken: "shpat_test",
    });

    const result = await recordWeleticRefund({
      event: sampleRefundEvent,
      shopDomain: "yamaxdev.myshopify.com",
    });

    // Verify resolveShopifyStoreByDomain was called with normalized domain
    expect(mocks.resolveStore).toHaveBeenCalledWith("yamaxdev.myshopify.com");
    // Verify direct findFirst/findUnique bypass was NEVER called
    expect(mocks.findFirstStore).not.toHaveBeenCalled();
    // Verify lock key uses canonical workspaceId
    expect(mocks.lastAcquiredLockKey).toBe("weletic:shopify:order:ws_yamax_canonical:11223344");
    // Verify downstream store was looked up strictly by projectId: workspaceId
    expect(mocks.findUniqueStore).toHaveBeenCalledWith({
      where: { projectId: "ws_yamax_canonical" },
    });
    expect(result).toBeDefined();
    expect(result.duplicate).toBe(false);
  });

  it("2. Resolves custom domain aliases seamlessly via canonical resolver", async () => {
    mocks.resolveStore.mockResolvedValueOnce({
      workspaceId: "ws_yamax_custom_alias",
      storeId: "wstore_yamax_001",
      shopId: "shop_123",
      primaryDomain: "shop.yamax.com",
      myshopifyDomain: "yamaxdev.myshopify.com",
      allDomains: ["shop.yamax.com", "yamaxdev.myshopify.com"],
      programId: "prog_yamax_001",
      accessToken: "shpat_test",
    });

    await recordWeleticRefund({
      event: sampleRefundEvent,
      shopDomain: "shop.yamax.com",
    });

    expect(mocks.resolveStore).toHaveBeenCalledWith("shop.yamax.com");
    expect(mocks.lastAcquiredLockKey).toBe("weletic:shopify:order:ws_yamax_custom_alias:11223344");
    expect(mocks.findUniqueStore).toHaveBeenCalledWith({
      where: { projectId: "ws_yamax_custom_alias" },
    });
  });

  it("3. Throws explicit descriptive error when store domain cannot be resolved", async () => {
    mocks.resolveStore.mockResolvedValueOnce(null);

    await expect(
      recordWeleticRefund({
        event: sampleRefundEvent,
        shopDomain: "unknown-store.myshopify.com",
      }),
    ).rejects.toThrow("Shopify store unknown-store.myshopify.com could not be resolved");

    // Distributed lock must NOT be acquired for unresolvable stores
    expect(mocks.lastAcquiredLockKey).toBeNull();
    expect(mocks.findUniqueStore).not.toHaveBeenCalled();
  });

  it("4. Prevents tenancy corruption: NEVER falls back to store.id when projectId is missing", async () => {
    // If resolveShopifyStoreByDomain returns an object with no workspaceId
    mocks.resolveStore.mockResolvedValueOnce({
      storeId: "wstore_corrupted_orphan",
      workspaceId: null,
    });

    await expect(
      recordWeleticRefund({
        event: sampleRefundEvent,
        shopDomain: "orphan.myshopify.com",
      }),
    ).rejects.toThrow("Shopify store orphan.myshopify.com could not be resolved");

    // Must never acquire lock using wstore_ ID
    expect(mocks.lastAcquiredLockKey).toBeNull();
    expect(mocks.findUniqueStore).not.toHaveBeenCalled();
  });

  it("5. Bypasses domain resolution when explicit workspaceId is provided directly", async () => {
    const result = await recordWeleticRefund({
      event: sampleRefundEvent,
      workspaceId: "ws_explicit_direct",
    });

    expect(mocks.resolveStore).not.toHaveBeenCalled();
    expect(mocks.findFirstStore).not.toHaveBeenCalled();
    expect(mocks.lastAcquiredLockKey).toBe("weletic:shopify:order:ws_explicit_direct:11223344");
    expect(mocks.findUniqueStore).toHaveBeenCalledWith({
      where: { projectId: "ws_explicit_direct" },
    });
    expect(result.duplicate).toBe(false);
  });

  it("6. Rejects with error if store record for canonical workspaceId was not synced in DB", async () => {
    mocks.resolveStore.mockResolvedValueOnce({
      workspaceId: "ws_unsynced_store",
      storeId: "wstore_missing",
    });
    mocks.findUniqueStore.mockResolvedValueOnce(null);

    await expect(
      recordWeleticRefund({
        event: sampleRefundEvent,
        shopDomain: "unsynced.myshopify.com",
      }),
    ).rejects.toThrow("Weletic Shopify store ws_unsynced_store was not synced.");
  });
});
