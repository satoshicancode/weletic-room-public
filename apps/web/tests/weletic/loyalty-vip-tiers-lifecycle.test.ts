import { prisma } from "@/lib/prisma";
import {
  calculateTierReviewWindow,
  evaluateTierMaintenanceCycle,
} from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  WeleticLoyaltyTierChangeReason,
  WeleticVipMilestoneMode,
  WeleticVipTimeframe,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite isolates tier accounting. Notification delivery and actual
// transactional rollback require separate producer and SQL coverage.
vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn().mockImplementation(async (params) => {
    return {
      id: `wpledger_mock_${Date.now()}`,
      sequenceNumber: 1,
      pointsDelta: params.pointsDelta,
      balanceAfter: BigInt(1000) + BigInt(params.pointsDelta),
      ...params,
    };
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn().mockImplementation(async (params) => {
    return {
      id: `woutbox_mock_${Date.now()}`,
      ...params,
    };
  }),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

describe("VIP Tier Engine & Lifecycle Management (Milestone 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Timeframe Calculation (calculateTierReviewWindow)", () => {
    it("computes exact 365-day window for ROLLING_12M", () => {
      const now = new Date("2026-08-26T12:00:00.000Z");
      const { startDate, endDate } = calculateTierReviewWindow(
        "ROLLING_12M",
        now,
      );

      expect(endDate.getTime()).toBe(now.getTime());
      expect(startDate.getTime()).toBe(
        now.getTime() - 365 * 24 * 60 * 60 * 1000,
      );
    });

    it("computes calendar year boundaries for CALENDAR_YEAR", () => {
      const now = new Date("2026-06-15T12:00:00.000Z");
      const { startDate, endDate } = calculateTierReviewWindow(
        "CALENDAR_YEAR",
        now,
        2025,
      );

      expect(startDate.toISOString()).toBe("2025-01-01T00:00:00.000Z");
      expect(endDate.toISOString()).toBe("2025-12-31T23:59:59.999Z");
    });

    it("computes unbounded lookback for LIFETIME", () => {
      const now = new Date("2026-08-26T12:00:00.000Z");
      const { startDate, endDate } = calculateTierReviewWindow("LIFETIME", now);

      expect(startDate.getTime()).toBe(0);
      expect(endDate.getTime()).toBe(now.getTime());
    });
  });

  describe("2. Milestone Qualification Modes", () => {
    const baseTiers = [
      {
        id: "tier_bronze",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
      },
      {
        id: "tier_gold",
        name: "Gold",
        tierOrder: 2,
        minSpendThreshold: BigInt(50000), // $500 in minor units
        minPointsThreshold: BigInt(1000),
      },
    ];

    it("evaluates qualification via 'amount_spent' mode", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_vip_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_1",
        currentTier: baseTiers[0],
        currentTierId: baseTiers[0].id,
        program: {
          vipMilestoneMode: WeleticVipMilestoneMode.amount_spent,
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipAutoDowngradeEnabled: true,
          tiers: baseTiers,
        },
      } as any);

      // Spend is $600 (qualified), points is 200 (under threshold, but amount_spent only cares about spend)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(60000) } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(200) } as any],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("tier_gold");
    });

    it("evaluates qualification via 'both' mode (spend AND points required)", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_vip_2";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_2",
        currentTier: baseTiers[0],
        currentTierId: baseTiers[0].id,
        program: {
          vipMilestoneMode: WeleticVipMilestoneMode.both,
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipAutoDowngradeEnabled: true,
          tiers: baseTiers,
        },
      } as any);

      // Spend is $600 (meets threshold), but points is only 800 (fails threshold for 'both')
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(60000) } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(800) } as any],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
      });

      // Does not qualify for Gold because points failed
      expect(result.status).toBe("MAINTAINED");
      expect(result.newTierId).toBe("tier_bronze");
    });
  });

  describe("3. Tier Promotion Workflow & Entry Bonus", () => {
    it("promotes account, creates tier history audit log, and awards entry bonus points", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_promo_1";

      const tiers = [
        {
          id: "tier_bronze",
          name: "Bronze",
          tierOrder: 1,
          minSpendThreshold: BigInt(0),
          minPointsThreshold: BigInt(0),
          entryBonusPoints: BigInt(0),
        },
        {
          id: "tier_platinum",
          name: "Platinum",
          tierOrder: 3,
          minSpendThreshold: BigInt(100000), // $1000
          minPointsThreshold: BigInt(0),
          entryBonusPoints: BigInt(500), // 500 bonus points
        },
      ];

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_promo_1",
        currentTier: tiers[0],
        currentTierId: tiers[0].id,
        program: {
          vipMilestoneMode: "amount_spent",
          vipTimeframe: "rolling_12m",
          vipAutoDowngradeEnabled: true,
          tiers,
        },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(150000) } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("tier_platinum");
      expect(result.tierChanged).toBe(true);

      // Verify Tier History record created
      expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            accountId,
            fromTierId: "tier_bronze",
            toTierId: "tier_platinum",
            changeReason: WeleticLoyaltyTierChangeReason.threshold_reached,
          }),
        }),
      );
    });
  });

  describe("4. 30-Day Downgrade Grace Period & Single-Tier Step-Down Demotion", () => {
    const tieredSystem = [
      {
        id: "tier_1",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
      },
      {
        id: "tier_2",
        name: "Silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(30000),
        minPointsThreshold: BigInt(0),
      },
      {
        id: "tier_3",
        name: "Gold",
        tierOrder: 3,
        minSpendThreshold: BigInt(60000),
        minPointsThreshold: BigInt(0),
      },
      {
        id: "tier_4",
        name: "Platinum",
        tierOrder: 4,
        minSpendThreshold: BigInt(100000),
        minPointsThreshold: BigInt(0),
      },
    ];

    it("grants a 30-day grace period without demoting when account first underperforms", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_grace_init";
      const now = new Date("2026-08-26T12:00:00.000Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_grace_1",
        currentTier: tieredSystem[3], // Currently Platinum (Order 4)
        currentTierId: "tier_4",
        tierExpiresAt: null, // No active grace period yet
        program: {
          vipMilestoneMode: "amount_spent",
          vipTimeframe: "rolling_12m",
          vipDowngradeGraceDays: 30,
          vipAutoDowngradeEnabled: true,
          tiers: tieredSystem,
        },
      } as any);

      // Qualifying spend dropped to $0 (qualifies only for Bronze)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        now,
      });

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("tier_4"); // Tier is PRESERVED!

      const expectedGraceExpiry = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      expect(result.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedGraceExpiry.toISOString(),
      );

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            tierExpiresAt: expectedGraceExpiry,
          }),
        }),
      );
    });

    it("single-tier step-down demotion: drops strictly from Platinum (order 4) to Gold (order 3) upon grace expiry", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_demote_1";
      const now = new Date("2026-08-26T12:00:00.000Z");
      const expiredGraceDate = new Date("2026-08-20T12:00:00.000Z"); // Grace period ended 6 days ago

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_demote_1",
        currentTier: tieredSystem[3], // Platinum (Order 4)
        currentTierId: "tier_4",
        tierExpiresAt: expiredGraceDate, // Grace period expired!
        program: {
          vipMilestoneMode: "amount_spent",
          vipTimeframe: "rolling_12m",
          vipDowngradeGraceDays: 30,
          vipAutoDowngradeEnabled: true,
          tiers: tieredSystem,
        },
      } as any);

      // Spend is $0 (qualifies only for Bronze), but single-tier step-down demotes only to Gold (Order 3)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        now,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.tierChanged).toBe(true);
      expect(result.previousTierId).toBe("tier_4");
      expect(result.newTierId).toBe("tier_3"); // GOLD! (Not Bronze!)

      expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            accountId,
            fromTierId: "tier_4",
            toTierId: "tier_3",
            changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
          }),
        }),
      );
    });

    it("protects base tier from ever being demoted", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_base_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_base_1",
        currentTier: tieredSystem[0], // Bronze (Order 1)
        currentTierId: "tier_1",
        tierExpiresAt: null,
        program: {
          vipMilestoneMode: "amount_spent",
          vipTimeframe: "rolling_12m",
          vipAutoDowngradeEnabled: true,
          tiers: tieredSystem,
        },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.newTierId).toBe("tier_1");
      expect(result.tierChanged).toBe(false);
    });

    it("cancels active grace period immediately when member re-qualifies", async () => {
      const storeId = "store_test_vip";
      const accountId = "acc_recover_1";
      const now = new Date("2026-08-26T12:00:00.000Z");
      const activeGraceDate = new Date("2026-09-15T12:00:00.000Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_rec_1",
        currentTier: tieredSystem[2], // Gold (Order 3)
        currentTierId: "tier_3",
        tierExpiresAt: activeGraceDate, // Currently in grace period
        program: {
          vipMilestoneMode: "amount_spent",
          vipTimeframe: "rolling_12m",
          vipAutoDowngradeEnabled: true,
          tiers: tieredSystem,
        },
      } as any);

      // Shopper completed a purchase of $700 (qualifies for Gold $600 threshold)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(70000) } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        now,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.newTierId).toBe("tier_3");

      // Verify tierExpiresAt was reset to null
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            tierExpiresAt: null,
          }),
        }),
      );
    });
  });
});
