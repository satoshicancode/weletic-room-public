import { describe, it, expect, vi, beforeEach } from "vitest";
import { addDays } from "date-fns";
import { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

// Mocks hoisted before imports
const domainMocks = vi.hoisted(() => ({
  appendPointsLedgerEntry: vi.fn().mockImplementation((params) => ({
    id: "ledger_test_id",
    storeId: params.storeId,
    accountId: params.accountId,
    pointsDelta: params.pointsDelta,
    balanceAfter: BigInt(1000) + params.pointsDelta,
    entryType: params.entryType,
    idempotencyKey: params.idempotencyKey,
    referenceId: params.referenceId,
    referenceType: params.referenceType,
    reason: params.reason,
    metadata: params.metadata,
    grantId: params.grantId,
  })),
  scheduleTierReview: vi.fn().mockResolvedValue(null),
  enqueueOutboxJob: vi.fn().mockResolvedValue({ id: "outbox_job_id" }),
  calculateNextPointsExpiryDate: vi.fn().mockReturnValue(new Date("2027-01-01T00:00:00.000Z")),
  hasCustomerRedactionTombstone: vi.fn().mockReturnValue(false),
  assertOperationalWrites: vi.fn().mockResolvedValue(undefined),
  assertInstallationGeneration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: domainMocks.appendPointsLedgerEntry,
  appendPointsLedgerEntryWithReceipt: async (params: any) => ({
    entry: await domainMocks.appendPointsLedgerEntry(params),
    created: true,
  }),
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
}));

vi.mock("@/lib/weletic/loyalty/points-communication-producer", () => ({
  enqueuePurchasePointsCommunication: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: domainMocks.enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction: vi.fn().mockResolvedValue({ id: "outbox_tx_job_id" }),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/points-expiry-policy", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    calculateNextPointsExpiryDate: domainMocks.calculateNextPointsExpiryDate,
    getPointsExpiryStageDate: vi.fn().mockReturnValue(new Date("2026-11-01T00:00:00.000Z")),
  };
});

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: domainMocks.hasCustomerRedactionTombstone,
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: domainMocks.scheduleTierReview,
  enqueueTierReviewSweepJobs: vi.fn().mockResolvedValue({
    programsScanned: 2,
    programsSkipped: 0,
    accountsEvaluated: 5,
    jobsEnqueued: 3,
    programFailures: [],
  }),
}));

vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    assertShopifyStoreAcceptsOperationalWrites: domainMocks.assertOperationalWrites,
    assertShopifyStoreMatchesInstallationGeneration: domainMocks.assertInstallationGeneration,
  };
});

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: async ({ operation }: any) => {
    return operation(prisma, null);
  },
}));

vi.mock("@/lib/weletic/loyalty/reward-expiry-scheduler", () => ({
  enqueueRewardExpiryReminderJobs: vi.fn().mockResolvedValue({
    rewardsScanned: 10,
    jobsEnqueued: 2,
  }),
}));

vi.mock("@/lib/prisma", () => {
  const mockDb = {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn(),
      create: vi.fn().mockImplementation((args) => Promise.resolve({ id: "grant_mock_id", ...args.data })),
      updateMany: vi.fn(),
    },
    weleticLoyaltyOrderLineEarn: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn().mockResolvedValue({ id: "issue_mock_id" }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn().mockResolvedValue({ id: "hist_id" }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (callback) => {
      if (typeof callback === "function") {
        return callback(mockDb);
      }
      return Promise.resolve();
    }),
  };
  return {
    prisma: mockDb,
    createPrismaClient: () => mockDb,
  };
});

import { prisma } from "@/lib/prisma";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { processOrderPointsEarn } from "@/lib/weletic/loyalty/earn";
import { enqueuePointsExpiryLifecycleJobs } from "@/lib/weletic/loyalty/points-expiry-scheduler";
import {
  vipTierReviewSweepJob,
  loyaltyPointsExpirationJob,
  handleHttpTrigger,
} from "../../../workers/cron-triggers/src/index";
import { enqueueTierReviewSweepJobs } from "@/lib/weletic/loyalty/tier-review-scheduling";

describe("Milestone 1: Loyalty Points & VIP Progression Defect & Fix Verifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Feature 1: VIP Sweep Edge Cron Inclusion
  // ==========================================================================
  describe("Feature 1: VIP Sweep Edge Cron Inclusion", () => {
    it("exports vipTierReviewSweepJob and enqueues sweep jobs via edge trigger", async () => {
      const mockEnv = {
        ENVIRONMENT: "test",
        DB: undefined,
      };

      const result = await vipTierReviewSweepJob(mockEnv);

      expect(enqueueTierReviewSweepJobs).toHaveBeenCalledWith({ batchSize: 50 });
      expect(result).toEqual({
        programsScanned: 2,
        programsSkipped: 0,
        accountsEvaluated: 5,
        jobsEnqueued: 3,
        programFailures: [],
      });
    });

    it("triggers enqueueTierReviewSweepJobs concurrently in loyaltyPointsExpirationJob", async () => {
      // Mock programs count in prisma for points expiry scheduler
      (prisma.weleticLoyaltyProgram.findMany as any).mockResolvedValueOnce([]);

      const mockEnv = {
        ENVIRONMENT: "test",
      };

      await loyaltyPointsExpirationJob(mockEnv);

      expect(enqueueTierReviewSweepJobs).toHaveBeenCalledWith({ batchSize: 50 });
    });

    it("handles tier-sweep via handleHttpTrigger route /api/cron/weletic/loyalty/tier-sweep", async () => {
      const mockEnv = {
        CRON_SECRET: "test-secret",
      };

      const request = new Request(
        "https://worker.internal/api/cron/weletic/loyalty/tier-sweep",
        {
          headers: {
            Authorization: "Bearer test-secret",
          },
        },
      );

      const response = await handleHttpTrigger(request, mockEnv);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toMatchObject({
        name: "vip-tier-review-sweep",
        status: "success",
      });
    });
  });

  // ==========================================================================
  // Feature 2: Inactive VIP Customer Downgrade Fix
  // ==========================================================================
  describe("Feature 2: Inactive VIP Customer Downgrade Fix", () => {
    it("sets non-null tierExpiresAt based on qualificationWindowDays on promotion", async () => {
      const now = new Date("2026-06-01T12:00:00.000Z");
      const storeId = "store_m1_test";
      const accountId = "acc_inactive_vip";

      const bronzeTier = {
        id: "tier_bronze",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
        qualificationWindowDays: 365,
      };

      const silverTier = {
        id: "tier_silver",
        name: "Silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(50_000), // $500
        minPointsThreshold: BigInt(500),
        qualificationWindowDays: 180, // 180 days qualification window
      };

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: accountId,
        storeId,
        shopperId: "shopper_vip",
        currentTierId: "tier_bronze",
        currentTier: bronzeTier,
        tierExpiresAt: null,
        shopper: { id: "shopper_vip" },
        program: {
          id: "prog_m1",
          storeId,
          tiers: [bronzeTier, silverTier],
        },
      });

      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValue([
        {
          id: "order_qualifying",
          shopNet: BigInt(60_000), // $600 qualifying spend
          presentmentNet: BigInt(60_000),
          occurredAt: now,
          status: "paid",
        },
      ]);
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValue([]);

      const res = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        now,
      });
      console.log("TIER RESULT:", res);

      // Verify update sets tierExpiresAt to exactly 180 days in future, NOT null
      const expectedExpiry = addDays(now, 180);
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: accountId },
        data: expect.objectContaining({
          currentTierId: "tier_silver",
          tierExpiresAt: expectedExpiry,
        }),
      });
    });

    it("defaults to 365 days if qualificationWindowDays is undefined", async () => {
      const now = new Date("2026-06-01T12:00:00.000Z");
      const storeId = "store_m1_test";
      const accountId = "acc_inactive_vip_default";

      const bronzeTier = {
        id: "tier_bronze",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
      };

      const goldTier = {
        id: "tier_gold",
        name: "Gold",
        tierOrder: 3,
        minSpendThreshold: BigInt(100_000),
        minPointsThreshold: BigInt(1_000),
        // qualificationWindowDays is omitted
      };

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: accountId,
        storeId,
        shopperId: "shopper_gold",
        currentTierId: "tier_bronze",
        currentTier: bronzeTier,
        tierExpiresAt: null,
        shopper: { id: "shopper_gold" },
        program: {
          id: "prog_m1",
          storeId,
          tiers: [bronzeTier, goldTier],
        },
      });

      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValue([
        {
          id: "order_gold_qualifying",
          shopNet: BigInt(150_000),
          presentmentNet: BigInt(150_000),
          occurredAt: now,
          status: "paid",
        },
      ]);
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValue([]);

      await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        now,
      });

      const expectedExpiry = addDays(now, 365);
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: accountId },
        data: expect.objectContaining({
          currentTierId: "tier_gold",
          tierExpiresAt: expectedExpiry,
        }),
      });
    });
  });

  // ==========================================================================
  // Feature 3: Earn Engine Exclusions Line Conditions
  // ==========================================================================
  describe("Feature 3: Earn Engine Exclusions Line Conditions", () => {
    const storeId = "store_m1_earn";
    const orderId = "order_m1_earn";
    const accountId = "account_m1_earn";
    const shopperId = "shopper_m1_earn";
    const occurredAt = new Date("2026-09-01T00:00:00.000Z");

    function baseCommerceOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: orderId,
        storeId,
        externalId: "gid://shopify/Order/m1-test",
        orderName: "#M1-TEST",
        occurredAt,
        createdAt: occurredAt,
        shopCurrency: "USD",
        presentmentCurrency: "USD",
        shopNet: BigInt(10_000), // $100
        presentmentNet: BigInt(10_000),
        shopTax: BigInt(1_000), // $10
        shopShipping: BigInt(500), // $5
        shopTotal: BigInt(11_500), // $115
        presentmentTax: BigInt(1_000),
        presentmentShipping: BigInt(500),
        presentmentTotal: BigInt(11_500),
        shopper: {
          id: shopperId,
          storeId,
          loyaltyAccount: {
            id: accountId,
            storeId,
            programId: "prog_m1_earn",
            program: { id: "prog_m1_earn", storeId },
            currentTierId: "tier_gold",
            currentTier: {
              id: "tier_gold",
              programId: "prog_m1_earn",
              pointsMultiplier: new Prisma.Decimal(1),
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
            tierHistory: [],
          },
        },
        lines: [
          {
            id: "line_1",
            externalId: "gid://shopify/LineItem/1",
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/1",
            title: "Performance Leggings",
            quantity: 1,
            shopGross: BigInt(10_000),
            shopDiscount: BigInt(0),
            shopNet: BigInt(10_000),
            presentmentNet: BigInt(10_000),
            productTags: ["activewear", "loyalty-exclusive"],
            collectionExternalIds: ["gid://shopify/Collection/bottoms"],
            sku: "YMX-LEG-01",
          },
        ],
        refunds: [],
        ...overrides,
      };
    }

    function baseLoyaltyProgram(earningRuleOverrides: Record<string, unknown> = {}) {
      return {
        id: "prog_m1_earn",
        storeId,
        status: "active",
        killSwitchActive: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        pointsPerCurrencyUnit: new Prisma.Decimal(1), // 1 point per $1
        holdingPeriodDays: 0,
        earningRules: [
          {
            id: "rule_order_paid_m1",
            triggerCode: "order_paid",
            isActive: true,
            priority: 100,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            startAt: null,
            endAt: null,
            eligibleTierIds: [],
            excludeDiscountedItems: false,
            excludeTaxesAndShipping: true,
            minOrderSubtotal: null,
            ruleType: "multiplier",
            fixedPoints: null,
            maxPointsPerEvent: null,
            multiplier: new Prisma.Decimal(1),
            conditions: null,
            ...earningRuleOverrides,
          },
        ],
        bonusCampaigns: [],
      };
    }

    it("calculates points inclusive of tax and shipping when excludeTaxesAndShipping is false", async () => {
      (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValue(baseCommerceOrder());
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValue(
        baseLoyaltyProgram({ excludeTaxesAndShipping: false }),
      );

      const result = await processOrderPointsEarn({
        storeId,
        orderId,
      });

      expect(result).not.toBeNull();
      // $100 net + $10 tax + $5 shipping = $115 total qualifying = 115 points
      expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pointsDelta: BigInt(115),
          storeId,
          accountId,
        }),
      );
      expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            grossPoints: BigInt(115),
            eligibleSubtotalAmount: BigInt(11_500),
          }),
        }),
      );
    });

    it("safely evaluates line conditions and excludes non-matching lines without halting calculation", async () => {
      (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValue(
        baseCommerceOrder({
          lines: [
            {
              id: "line_matched",
              externalId: "gid://shopify/LineItem/matched",
              productId: "gid://shopify/Product/1",
              variantId: "gid://shopify/ProductVariant/1",
              title: "VIP Exclusive Leggings",
              quantity: 1,
              shopGross: BigInt(6_000), // $60
              shopDiscount: BigInt(0),
              shopNet: BigInt(6_000),
              presentmentNet: BigInt(6_000),
              productTags: ["loyalty-exclusive"],
            },
            {
              id: "line_unmatched",
              externalId: "gid://shopify/LineItem/unmatched",
              productId: "gid://shopify/Product/2",
              variantId: "gid://shopify/ProductVariant/2",
              title: "Regular Socks",
              quantity: 1,
              shopGross: BigInt(4_000), // $40
              shopDiscount: BigInt(0),
              shopNet: BigInt(4_000),
              presentmentNet: BigInt(4_000),
              productTags: ["accessories"],
            },
          ],
        }),
      );

      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValue(
        baseLoyaltyProgram({
          conditions: { productTags: ["loyalty-exclusive"] },
        }),
      );

      const result = await processOrderPointsEarn({
        storeId,
        orderId,
      });

      expect(result).not.toBeNull();
      // Only the $60 line matches the loyalty-exclusive tag condition
      expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pointsDelta: BigInt(60),
          storeId,
          accountId,
        }),
      );
      expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            grossPoints: BigInt(60),
            eligibleSubtotalAmount: BigInt(6_000),
          }),
        }),
      );
    });
  });

  // ==========================================================================
  // Feature 4: Points Expiry Multi-Store Fair Batching
  // ==========================================================================
  describe("Feature 4: Points Expiry Multi-Store Fair Batching", () => {
    it("partitions batch quota fairly across stores and prevents single-store starvation", async () => {
      const store1Program = {
        id: "prog_store_1",
        storeId: "store_1",
        status: "active",
        pointsExpiryMonths: 6,
        pointsExpiryDays: 0,
        pointsExpiryPolicyVersion: 1,
        pointsExpiryPolicyAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      const store2Program = {
        id: "prog_store_2",
        storeId: "store_2",
        status: "active",
        pointsExpiryMonths: 12,
        pointsExpiryDays: 0,
        pointsExpiryPolicyVersion: 1,
        pointsExpiryPolicyAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      (prisma.weleticLoyaltyProgram.findMany as any).mockResolvedValue([
        store1Program,
        store2Program,
      ]);
      (prisma.weleticLoyaltyProgram.findUnique as any).mockImplementation(
        (args: any) => {
          if (args.where.storeId === "store_1") return Promise.resolve(store1Program);
          if (args.where.storeId === "store_2") return Promise.resolve(store2Program);
          return Promise.resolve(null);
        },
      );

      // Mock finding accounts for store 1 and store 2
      // Store 1 has 100 accounts available, but with batchSize 20 and 2 stores,
      // Store 1 quota is ceil(20 / 2) = 10 accounts.
      let store1QueriedTake = 0;
      let store2QueriedTake = 0;

      (prisma.weleticLoyaltyAccount.findMany as any).mockImplementation((args: any) => {
        if (args.where.storeId === "store_1") {
          store1QueriedTake = args.take;
          // Return quota accounts
          return Array.from({ length: args.take }, (_, idx) => ({
            id: `acc_store1_${idx}`,
            storeId: "store_1",
            pointsExpiryPolicyVersion: 0,
            cachedPointsBalance: BigInt(100),
            pointsExpireAt: new Date("2026-05-01T00:00:00.000Z"),
            nextExpiryDate: new Date("2026-05-01T00:00:00.000Z"),
          }));
        } else if (args.where.storeId === "store_2") {
          store2QueriedTake = args.take;
          return Array.from({ length: args.take }, (_, idx) => ({
            id: `acc_store2_${idx}`,
            storeId: "store_2",
            pointsExpiryPolicyVersion: 0,
            cachedPointsBalance: BigInt(200),
            pointsExpireAt: new Date("2026-05-01T00:00:00.000Z"),
            nextExpiryDate: new Date("2026-05-01T00:00:00.000Z"),
          }));
        }
        return [];
      });

      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({ count: 1 });

      const result = await enqueuePointsExpiryLifecycleJobs({ batchSize: 20 });

      // Fair batching: store 1 queried at most its fair quota (10), leaving 10 for store 2
      expect(store1QueriedTake).toBe(10);
      expect(store2QueriedTake).toBe(10);
      expect(result.programsScanned).toBe(2);
      expect(result.accountsReconciled).toBe(20);
    });
  });
});
