import { prisma } from "@/lib/prisma";
import {
  calculatePointsLiability,
  calculateReferralEconomics,
  getLoyaltyDashboardOverview,
  getLoyaltyProgramHealthMetrics,
  getLoyaltyTierDistribution,
} from "@/lib/weletic/loyalty/analytics";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
  },
}));

describe("Weletic Customer Loyalty Analytics & Points Liability Engine (Milestone 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValue([]);
  });

  // =========================================================================
  // 1. Points Liability Engine & Multi-Currency Valuation
  // =========================================================================
  describe("Points Liability Engine & Multi-Currency Valuation", () => {
    it("calculates real-time circulating points and monetary liability in USD (2-decimal)", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago (Active)
        },
        {
          cachedPointsBalance: BigInt(1200),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago (Active)
        },
        {
          cachedPointsBalance: BigInt(300),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000), // 150 days ago (Inactive)
        },
      ] as any);

      // 500 + 1200 + 300 = 2,000 points
      // At $0.01 per point (1 minor unit / cent) = 2,000 cents = $20.00
      const result = await calculatePointsLiability({
        storeId: "store_yamax",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.storeId).toBe("store_yamax");
      expect(result.currency).toBe("USD");
      expect(result.isZeroDecimal).toBe(false);
      expect(result.totalMembersCount).toBe(3);
      expect(result.activeMembersCount).toBe(2);
      expect(result.inactiveMembersCount).toBe(1);
      expect(result.totalCirculatingPoints).toBe(BigInt(2000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(2000));
      expect(result.totalLiabilityDecimal).toBe("20.00");
      expect(result.averagePointsPerMember).toBeCloseTo(666.67, 1);
      expect(result.averageLiabilityPerMemberMinorUnits).toBe(BigInt(666));
    });

    it("calculates points liability with JPY (0-decimal currency) without decimal loss", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        },
        {
          cachedPointsBalance: BigInt(2500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        },
      ] as any);

      // 3,500 points at ¥1 per point = ¥3,500
      const result = await calculatePointsLiability({
        storeId: "store_tokyo",
        currency: "JPY",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.currency).toBe("JPY");
      expect(result.isZeroDecimal).toBe(true);
      expect(result.totalCirculatingPoints).toBe(BigInt(3500));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(3500));
      expect(result.totalLiabilityDecimal).toBe("3500");
      expect(result.averagePointsPerMember).toBe(1750);
    });

    it("calculates points liability with VND (0-decimal currency)", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(5000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        },
      ] as any);

      // 5,000 points at 10 VND/pt = 50,000 VND
      const result = await calculatePointsLiability({
        storeId: "store_saigon",
        currency: "VND",
        valuationPerPointMinorUnits: 10,
      });

      expect(result.currency).toBe("VND");
      expect(result.isZeroDecimal).toBe(true);
      expect(result.totalCirculatingPoints).toBe(BigInt(5000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(50000));
      expect(result.totalLiabilityDecimal).toBe("50000");
    });

    it("calculates pending points liability and total potential liability", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000),
          cachedPendingPoints: BigInt(500),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(2000),
          cachedPendingPoints: BigInt(300),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      // Circulating: 3,000 pts ($30.00)
      // Pending: 800 pts ($8.00)
      // Potential Total: 3,800 pts ($38.00)
      const result = await calculatePointsLiability({
        storeId: "store_yamax",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.totalCirculatingPoints).toBe(BigInt(3000));
      expect(result.totalPendingPoints).toBe(BigInt(800));
      expect(result.totalPotentialPoints).toBe(BigInt(3800));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(3000));
      expect(result.totalPendingLiabilityMinorUnits).toBe(BigInt(800));
      expect(result.totalPotentialLiabilityMinorUnits).toBe(BigInt(3800));
      expect(result.totalLiabilityDecimal).toBe("30.00");
      expect(result.totalPendingLiabilityDecimal).toBe("8.00");
      expect(result.totalPotentialLiabilityDecimal).toBe("38.00");
    });

    it("handles negative points balance debt without corrupting circulating liability", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000), // Positive
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(-250), // Negative balance debt from late refund clawback
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const result = await calculatePointsLiability({
        storeId: "store_yamax",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      // Circulating liability should reflect positive claims
      expect(result.totalCirculatingPoints).toBe(BigInt(1000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(1000));
      expect(result.negativeBalancePointsDebt).toBe(BigInt(250));
      expect(result.negativeBalanceAccountsCount).toBe(1);
      expect(result.netCirculatingPoints).toBe(BigInt(750));
    });

    it("supports valuationPerPointMajor parameter", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(100),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      // $0.05 major units = 5 cents per point
      const result = await calculatePointsLiability({
        storeId: "store_yamax",
        currency: "USD",
        valuationPerPointMajor: 0.05,
      });

      expect(result.valuationPerPointMinorUnits).toBe(BigInt(5));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(500));
      expect(result.totalLiabilityDecimal).toBe("5.00");
    });

    it("handles empty account set gracefully with zero values", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await calculatePointsLiability({
        storeId: "store_empty",
        currency: "USD",
      });

      expect(result.totalMembersCount).toBe(0);
      expect(result.activeMembersCount).toBe(0);
      expect(result.totalCirculatingPoints).toBe(BigInt(0));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(0));
      expect(result.totalLiabilityDecimal).toBe("0.00");
      expect(result.averagePointsPerMember).toBe(0);
    });
  });

  // =========================================================================
  // 2. Program Health, Redemption & Breakage Metrics
  // =========================================================================
  describe("Program Health, Redemption & Breakage Metrics", () => {
    it("calculates program health metrics: participation rate, redemption rate, breakage", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(500),
          status: "active",
          updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago (Active)
        },
        {
          cachedPointsBalance: BigInt(1200),
          status: "active",
          updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago (Active)
        },
        {
          cachedPointsBalance: BigInt(300),
          status: "active",
          updatedAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000), // 150 days ago (Inactive)
        },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(1000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            pointsDelta: BigInt(1000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            pointsDelta: BigInt(-500),
            entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          },
        ] as any,
      );

      const metrics = await getLoyaltyProgramHealthMetrics("store_yamax");

      expect(metrics.totalMembers).toBe(3);
      expect(metrics.activeMembers).toBe(2);
      expect(metrics.inactiveMembers).toBe(1);
      expect(metrics.participationRate).toBe(66.7);
      expect(metrics.activeRate).toBe(66.7);
      expect(metrics.totalPointsEarned).toBe(BigInt(2000));
      expect(metrics.totalPointsRedeemed).toBe(BigInt(500));
      expect(metrics.redemptionRate).toBe(25.0); // 500 / 2000 = 25%
      expect(metrics.breakageRate).toBe(75.0);
    });

    it("correctly breaks down refund reversals and expired points in ledger accounting", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(3000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            pointsDelta: BigInt(-600),
            entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          },
          {
            pointsDelta: BigInt(-400),
            entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
          },
          {
            pointsDelta: BigInt(-200),
            entryType: WeleticPointsLedgerEntryType.EXPIRATION,
          },
        ] as any,
      );

      const metrics = await getLoyaltyProgramHealthMetrics({
        storeId: "store_yamax",
        currency: "USD",
      });

      expect(metrics.totalPointsEarned).toBe(BigInt(3000));
      expect(metrics.totalPointsRedeemed).toBe(BigInt(600));
      expect(metrics.totalPointsRefundReversed).toBe(BigInt(400));
      expect(metrics.totalPointsExpired).toBe(BigInt(200));
      // Net Outstanding: 3000 - 600 - 400 - 200 = 1800
      expect(metrics.netOutstandingPoints).toBe(BigInt(1800));
      expect(metrics.redemptionRate).toBe(20.0); // 600 / 3000 = 20%
      expect(metrics.breakageRate).toBe(80.0);
    });

    it("handles zero earned points edge case without division-by-zero", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        [],
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const metrics = await getLoyaltyProgramHealthMetrics("store_empty");

      expect(metrics.totalMembers).toBe(0);
      expect(metrics.activeMembers).toBe(0);
      expect(metrics.participationRate).toBe(0);
      expect(metrics.totalPointsEarned).toBe(BigInt(0));
      expect(metrics.totalPointsRedeemed).toBe(BigInt(0));
      expect(metrics.redemptionRate).toBe(0);
      expect(metrics.breakageRate).toBe(100);
    });
  });

  // =========================================================================
  // 3. Referral Program Economics (CAC & ROI)
  // =========================================================================
  describe("Referral Program Economics (CAC & ROI)", () => {
    it("pure helper calculateReferralEconomics computes exact CAC, conversion, and ROI", () => {
      // 100 referrals, 25 converted (25% conversion)
      // Total reward points awarded: 2,500 points (2,500 cents = $25.00 cost)
      // Revenue generated: $250.00 (25,000 cents)
      const econ = calculateReferralEconomics({
        totalReferrals: 100,
        successfulReferrals: 25,
        totalRewardPoints: BigInt(2500),
        revenueMinorUnits: BigInt(25000),
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(econ.totalReferrals).toBe(100);
      expect(econ.successfulReferrals).toBe(25);
      expect(econ.referralConversionRate).toBe(25.0);
      expect(econ.referralRewardCostMinorUnits).toBe(BigInt(2500));
      expect(econ.referralRevenueMinorUnits).toBe(BigInt(25000));
      expect(econ.referralCACMinorUnits).toBe(BigInt(100)); // 2500 / 25 = 100 cents
      expect(econ.referralCAC).toBe(1.0); // $1.00 CAC
      // ROI: ((25000 - 2500) / 2500) * 100 = 900.0%
      expect(econ.referralROI).toBe(900.0);
      expect(econ.referralROIMultiplier).toBe(10.0);
    });

    it("calculateReferralEconomics handles zero referrals and zero cost safely", () => {
      const zeroEcon = calculateReferralEconomics({
        totalReferrals: 0,
        successfulReferrals: 0,
        totalRewardPoints: 0,
        revenueMinorUnits: 0,
      });

      expect(zeroEcon.referralConversionRate).toBe(0);
      expect(zeroEcon.referralCAC).toBeNull();
      expect(zeroEcon.referralROI).toBeNull();
      expect(zeroEcon.referralROIMultiplier).toBeNull();
      expect(zeroEcon.referralROIReason).toMatch(/cost is zero/);
    });

    it("calculates end-to-end referral metrics in getLoyaltyProgramHealthMetrics", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(100),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(500),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any,
      );

      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce([
        {
          id: "ref_1",
          status: "rewarded",
          advocatePointsAwarded: BigInt(100),
          refereePointsAwarded: BigInt(50),
          qualifyingOrderId: "order_1",
        },
        {
          id: "ref_2",
          status: "rewarded",
          advocatePointsAwarded: BigInt(100),
          refereePointsAwarded: BigInt(50),
          qualifyingOrderId: "order_2",
        },
        {
          id: "ref_3",
          status: "pending",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
          qualifyingOrderId: null,
        },
      ] as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "order_1",
          accountingCurrency: "USD",
          accountingNet: BigInt(10000),
        }, // $100.00
        {
          id: "order_2",
          accountingCurrency: "USD",
          accountingNet: BigInt(15000),
        }, // $150.00
      ] as any);

      const metrics = await getLoyaltyProgramHealthMetrics({
        storeId: "store_yamax",
        currency: "USD",
        valuationPerPointMinorUnits: 1, // $0.01/pt
      });

      // 3 total referrals, 2 rewarded -> 66.7% conversion
      // Total reward points = (100 + 50) * 2 = 300 points ($3.00 cost = 300 cents)
      // Revenue = $100 + $150 = $250.00 (25,000 cents)
      // CAC = 300 cents / 2 = 150 cents ($1.50)
      // ROI = ((25000 - 300) / 300) * 100 = 8233.3%
      expect(metrics.totalReferrals).toBe(3);
      expect(metrics.successfulReferrals).toBe(2);
      expect(metrics.referralConversionRate).toBe(66.7);
      expect(metrics.referralRewardCostMinorUnits).toBe(BigInt(300));
      expect(metrics.referralRevenueMinorUnits).toBe(BigInt(25000));
      expect(metrics.referralCAC).toBe(1.5);
      expect(metrics.referralROI).toBe(8233.3);
    });
  });

  // =========================================================================
  // 4. VIP Tier Distribution & Dashboard Overview Aggregation
  // =========================================================================
  describe("VIP Tier Distribution & Dashboard Overview", () => {
    it("aggregates member counts, points balances, and rolling spend per VIP tier", async () => {
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce({
        id: "prog_yamax",
        storeId: "store_yamax",
        tiers: [
          { id: "tier_bronze", name: "Bronze", slug: "bronze", tierOrder: 1 },
          { id: "tier_silver", name: "Silver", slug: "silver", tierOrder: 2 },
          { id: "tier_gold", name: "Gold", slug: "gold", tierOrder: 3 },
        ],
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          id: "acc_1",
          currentTierId: "tier_bronze",
          cachedPointsBalance: BigInt(200),
          tierSpendRolling12Months: BigInt(5000),
        },
        {
          id: "acc_2",
          currentTierId: "tier_silver",
          cachedPointsBalance: BigInt(1500),
          tierSpendRolling12Months: BigInt(25000),
        },
        {
          id: "acc_3",
          currentTierId: "tier_silver",
          cachedPointsBalance: BigInt(800),
          tierSpendRolling12Months: BigInt(18000),
        },
        {
          id: "acc_4",
          currentTierId: "tier_gold",
          cachedPointsBalance: BigInt(5000),
          tierSpendRolling12Months: BigInt(80000),
        },
      ] as any);

      const distribution = await getLoyaltyTierDistribution({
        storeId: "store_yamax",
      });

      expect(distribution).toHaveLength(3);

      const bronze = distribution.find((t) => t.tierId === "tier_bronze")!;
      expect(bronze.memberCount).toBe(1);
      expect(bronze.percentageOfTotal).toBe(25.0);
      expect(bronze.totalPointsBalance).toBe(BigInt(200));
      expect(bronze.totalRollingSpend).toBe(BigInt(5000));

      const silver = distribution.find((t) => t.tierId === "tier_silver")!;
      expect(silver.memberCount).toBe(2);
      expect(silver.percentageOfTotal).toBe(50.0);
      expect(silver.totalPointsBalance).toBe(BigInt(2300));
      expect(silver.totalRollingSpend).toBe(BigInt(43000));

      const gold = distribution.find((t) => t.tierId === "tier_gold")!;
      expect(gold.memberCount).toBe(1);
      expect(gold.percentageOfTotal).toBe(25.0);
      expect(gold.totalPointsBalance).toBe(BigInt(5000));
      expect(gold.totalRollingSpend).toBe(BigInt(80000));
    });

    it("generates a unified Merchant Dashboard Overview payload", async () => {
      // Mock for calculatePointsLiability
      vi.mocked(prisma.weleticLoyaltyAccount.findMany)
        .mockResolvedValueOnce([
          {
            cachedPointsBalance: BigInt(1000),
            cachedPendingPoints: BigInt(200),
            status: "active",
            updatedAt: new Date(),
          },
        ] as any)
        // Mock for getLoyaltyProgramHealthMetrics accounts
        .mockResolvedValueOnce([
          {
            cachedPointsBalance: BigInt(1000),
            status: "active",
            updatedAt: new Date(),
          },
        ] as any)
        // Mock for getLoyaltyTierDistribution accounts
        .mockResolvedValueOnce([
          {
            id: "acc_1",
            currentTierId: "tier_1",
            cachedPointsBalance: BigInt(1000),
            tierSpendRolling12Months: BigInt(10000),
          },
        ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(1000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any,
      );

      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce(
        [],
      );

      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce({
        id: "prog_1",
        tiers: [{ id: "tier_1", name: "VIP", tierOrder: 1 }],
      } as any);

      const overview = await getLoyaltyDashboardOverview({
        storeId: "store_yamax",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(overview.storeId).toBe("store_yamax");
      expect(overview.currency).toBe("USD");
      expect(overview.liability.totalCirculatingPoints).toBe(BigInt(1000));
      expect(overview.healthMetrics.totalPointsEarned).toBe(BigInt(1000));
      expect(overview.tierDistribution).toHaveLength(1);
      expect(overview.generatedAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // 5. Date Range Filtering
  // =========================================================================
  describe("Date Range Filtering", () => {
    it("applies date range bounds to ledger and referral queries", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        [],
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );
      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce(
        [],
      );

      const startDate = new Date("2026-01-01T00:00:00Z");
      const endDate = new Date("2026-06-30T23:59:59Z");

      const metrics = await getLoyaltyProgramHealthMetrics({
        storeId: "store_filtered",
        dateRange: { startDate, endDate },
      });

      expect(metrics.dateRange).toEqual({ startDate, endDate });
      expect(prisma.weleticPointsLedgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            storeId: "store_filtered",
            createdAt: { gte: startDate, lte: endDate },
          }),
        }),
      );
      expect(prisma.weleticLoyaltyReferral.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            storeId: "store_filtered",
            createdAt: { gte: startDate, lte: endDate },
          }),
        }),
      );
    });
  });
});
