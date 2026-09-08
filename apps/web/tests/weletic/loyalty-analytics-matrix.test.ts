import { prisma } from "@/lib/prisma";
import {
  calculateCohortMetricsPure,
  calculateMemberCohortAttribution,
  calculatePointsLiability,
  calculateReferralEconomics,
  escapeCsvUntrustedTextCell,
  exportLoyaltyMetricsCsv,
  exportLoyaltyMetricsJson,
  getLoyaltyProgramHealthMetrics,
  scrubPiiToCryptographicDigest,
} from "@/lib/weletic/loyalty/analytics";
import {
  evaluateOrderCurrencyDataQuality,
  resolveLoyaltyFinancialConfiguration,
} from "@/lib/weletic/loyalty/analytics-financial";
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
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
  },
}));

describe("Loyalty Analytics & Financial Liability Engine — Deterministic Matrix Suite", () => {
  const storeId = "store_matrix_matrix";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(null);
  });

  describe("0. Financial configuration validity", () => {
    it("distinguishes absent valuation from corrupt partial configuration", () => {
      expect(
        resolveLoyaltyFinancialConfiguration({ accountingCurrency: "JPY" }),
      ).toMatchObject({ status: "unconfigured", valuation: null });

      expect(
        resolveLoyaltyFinancialConfiguration({
          accountingCurrency: "JPY",
          liabilityValuationCurrency: "JPY",
          liabilityMinorUnitsNumerator: BigInt(1),
        }),
      ).toMatchObject({ status: "invalid", valuation: null });
    });

    it("rejects a zero-valued liability ratio", async () => {
      await expect(
        calculatePointsLiability({
          storeId,
          currency: "JPY",
          liabilityMinorUnitsNumerator: BigInt(0),
          liabilityPointsDenominator: BigInt(100),
        }),
      ).rejects.toThrow(/must be positive/);
      expect(prisma.weleticLoyaltyAccount.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 1. Multi-Currency Points Liability Matrix (USD, EUR, JPY, VND, BHD)
  // =========================================================================
  describe("1. Multi-Currency Liability Matrix (USD, EUR, JPY, VND, BHD)", () => {
    it("evaluates USD (2-decimal) liability with exact cent integer scaling", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1234),
          cachedPendingPoints: BigInt(200),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      // 1,234 points @ 1 cent = 1,234 cents = $12.34
      // 200 pending points @ 1 cent = 200 cents = $2.00
      const result = await calculatePointsLiability({
        storeId,
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.currency).toBe("USD");
      expect(result.isZeroDecimal).toBe(false);
      expect(result.totalCirculatingPoints).toBe(BigInt(1234));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(1234));
      expect(result.totalLiabilityDecimal).toBe("12.34");
      expect(result.totalPendingPoints).toBe(BigInt(200));
      expect(result.totalPendingLiabilityDecimal).toBe("2.00");
      expect(result.totalPotentialLiabilityDecimal).toBe("14.34");
    });

    it("evaluates EUR (2-decimal) liability with customized valuation per point", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(25000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      // 25,000 points @ €0.02 (2 minor units / cents) = 50,000 cents = €500.00
      const result = await calculatePointsLiability({
        storeId,
        currency: "EUR",
        valuationPerPointMinorUnits: 2,
      });

      expect(result.currency).toBe("EUR");
      expect(result.isZeroDecimal).toBe(false);
      expect(result.totalCirculatingPoints).toBe(BigInt(25000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(50000));
      expect(result.totalLiabilityDecimal).toBe("500.00");
    });

    it("evaluates JPY (0-decimal) without decimal cents", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(50000),
          cachedPendingPoints: BigInt(5000),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      // 50,000 points @ ¥1 = ¥50,000 (no decimal dots)
      const result = await calculatePointsLiability({
        storeId,
        currency: "JPY",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.currency).toBe("JPY");
      expect(result.isZeroDecimal).toBe(true);
      expect(result.totalCirculatingPoints).toBe(BigInt(50000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(50000));
      expect(result.totalLiabilityDecimal).toBe("50000");
      expect(result.totalPendingLiabilityDecimal).toBe("5000");
      expect(result.totalPotentialLiabilityDecimal).toBe("55000");
    });

    it("rounds a ¥1 per 100 points valuation once at the aggregate boundary", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(50),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          cachedPointsBalance: BigInt(50),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      const result = await calculatePointsLiability({
        storeId,
        currency: "JPY",
        liabilityMinorUnitsNumerator: BigInt(1),
        liabilityPointsDenominator: BigInt(100),
      });

      expect(result.totalCirculatingPoints).toBe(BigInt(100));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(1));
      expect(result.totalLiabilityDecimal).toBe("1");
      expect(result.valuationPerPointMinorUnits).toBeNull();
    });

    it("evaluates VND (0-decimal) with integer scaling", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      // 1,000,000 points @ 10 VND = 10,000,000 VND
      const result = await calculatePointsLiability({
        storeId,
        currency: "VND",
        valuationPerPointMinorUnits: 10,
      });

      expect(result.currency).toBe("VND");
      expect(result.isZeroDecimal).toBe(true);
      expect(result.totalCirculatingPoints).toBe(BigInt(1000000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(10000000));
      expect(result.totalLiabilityDecimal).toBe("10000000");
    });

    it("evaluates BHD (3-decimal) preserving exact fils fractional precision", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(15000),
          cachedPendingPoints: BigInt(2500),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      // 15,000 points @ 5 fils (5 minor units) = 75,000 fils = 75.000 BHD
      // 2,500 pending points @ 5 fils = 12,500 fils = 12.500 BHD
      const result = await calculatePointsLiability({
        storeId,
        currency: "BHD",
        valuationPerPointMinorUnits: 5,
      });

      expect(result.currency).toBe("BHD");
      expect(result.isZeroDecimal).toBe(false);
      expect(result.totalCirculatingPoints).toBe(BigInt(15000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(75000));
      expect(result.totalLiabilityDecimal).toBe("75.000");
      expect(result.totalPendingLiabilityDecimal).toBe("12.500");
      expect(result.totalPotentialLiabilityDecimal).toBe("87.500");
    });
  });

  // =========================================================================
  // 2. Negative Balance Debt Accounting & Solvency Matrix
  // =========================================================================
  describe("2. Negative Balance Debt Accounting & Solvency Matrix", () => {
    it("segregates refund clawback negative balances from gross circulating liability", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(10000), // Solvent member (+10,000)
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          cachedPointsBalance: BigInt(-2500), // Insolvent refund clawback (-2,500)
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          cachedPointsBalance: BigInt(5000), // Solvent member (+5,000)
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          cachedPointsBalance: BigInt(-1000), // Insolvent member (-1,000)
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ] as any);

      const result = await calculatePointsLiability({
        storeId,
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      // Gross positive points: 10,000 + 5,000 = 15,000
      // Negative debt points: 2,500 + 1,000 = 3,500
      // Net circulating points: 15,000 - 3,500 = 11,500
      expect(result.totalCirculatingPoints).toBe(BigInt(15000));
      expect(result.negativeBalancePointsDebt).toBe(BigInt(3500));
      expect(result.negativeBalanceAccountsCount).toBe(2);
      expect(result.netCirculatingPoints).toBe(BigInt(11500));
      // Gross liability must remain full 15,000 cents ($150.00), not understated by bad debt!
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(15000));
      expect(result.totalLiabilityDecimal).toBe("150.00");
    });

    it("handles 100% insolvent store scenario without negative circulating underflow", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(-500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(-1200),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const result = await calculatePointsLiability({
        storeId,
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.totalCirculatingPoints).toBe(BigInt(0));
      expect(result.negativeBalancePointsDebt).toBe(BigInt(1700));
      expect(result.negativeBalanceAccountsCount).toBe(2);
      expect(result.netCirculatingPoints).toBe(BigInt(-1700));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(0));
      expect(result.totalLiabilityDecimal).toBe("0.00");
    });
  });

  // =========================================================================
  // 3. Segmentation Lookback Windows Matrix (30d, 60d, 90d, 180d, 365d)
  // =========================================================================
  describe("3. Segmentation Lookback Windows Matrix", () => {
    const referenceNow = new Date("2026-09-04T12:00:00.000Z");

    const buildAccountsForSegmentation = () => [
      // 10 days ago (Active across all windows)
      {
        cachedPointsBalance: BigInt(100),
        status: "active",
        updatedAt: new Date(referenceNow.getTime() - 10 * 86_400_000),
      },
      // 45 days ago (Inactive for 30d; Active for 60d, 90d, 180d, 365d)
      {
        cachedPointsBalance: BigInt(100),
        status: "active",
        updatedAt: new Date(referenceNow.getTime() - 45 * 86_400_000),
      },
      // 75 days ago (Inactive for 30d, 60d; Active for 90d, 180d, 365d)
      {
        cachedPointsBalance: BigInt(100),
        status: "active",
        updatedAt: new Date(referenceNow.getTime() - 75 * 86_400_000),
      },
      // 120 days ago (Inactive for 30d, 60d, 90d; Active for 180d, 365d)
      {
        cachedPointsBalance: BigInt(100),
        status: "active",
        updatedAt: new Date(referenceNow.getTime() - 120 * 86_400_000),
      },
      // 250 days ago (Inactive for 30d, 60d, 90d, 180d; Active for 365d)
      {
        cachedPointsBalance: BigInt(100),
        status: "active",
        updatedAt: new Date(referenceNow.getTime() - 250 * 86_400_000),
      },
      // 400 days ago (Inactive for all windows)
      {
        cachedPointsBalance: BigInt(100),
        status: "active",
        updatedAt: new Date(referenceNow.getTime() - 400 * 86_400_000),
      },
    ];

    const testCases = [
      { lookbackDays: 30, expectedActive: 1, expectedInactive: 5 },
      { lookbackDays: 60, expectedActive: 2, expectedInactive: 4 },
      { lookbackDays: 90, expectedActive: 3, expectedInactive: 3 },
      { lookbackDays: 180, expectedActive: 4, expectedInactive: 2 },
      { lookbackDays: 365, expectedActive: 5, expectedInactive: 1 },
    ];

    testCases.forEach(({ lookbackDays, expectedActive, expectedInactive }) => {
      it(`evaluates ${lookbackDays}d window with deterministic reference now: ${expectedActive} active, ${expectedInactive} inactive`, async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
          buildAccountsForSegmentation() as any,
        );

        const result = await calculatePointsLiability({
          storeId,
          currency: "USD",
          activeLookbackDays: lookbackDays,
          now: referenceNow,
        });

        expect(result.totalMembersCount).toBe(6);
        expect(result.activeMembersCount).toBe(expectedActive);
        expect(result.inactiveMembersCount).toBe(expectedInactive);
      });
    });
  });

  // =========================================================================
  // 4. Program Health, Redemption Velocity & Breakage Rates Matrix
  // =========================================================================
  describe("4. Program Health, Redemption Velocity & Breakage Rates Matrix", () => {
    it("classifies backfill and manual adjustments through explicit allowlists", async () => {
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          { pointsDelta: BigInt(100), entryType: "EARN_ORDER" },
          { pointsDelta: BigInt(50), entryType: "BACKFILL" },
          { pointsDelta: BigInt(-20), entryType: "BACKFILL_CORRECTION" },
          { pointsDelta: BigInt(10), entryType: "MANUAL_ADJUSTMENT" },
          { pointsDelta: BigInt(-4), entryType: "MANUAL_ADJUSTMENT" },
          { pointsDelta: BigInt(-7), entryType: "REDEEM_REWARD" },
          { pointsDelta: BigInt(-5), entryType: "REFUND_REVERSAL" },
          { pointsDelta: BigInt(-3), entryType: "EXPIRATION" },
          { pointsDelta: BigInt(999), entryType: "REDEEM_REWARD" },
          { pointsDelta: BigInt(-999), entryType: "EARN_ORDER" },
        ] as any,
      );

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.totalPointsEarned).toBe(BigInt(150));
      expect(health.totalPointsBackfilled).toBe(BigInt(50));
      expect(health.totalPointsBackfillCorrected).toBe(BigInt(20));
      expect(health.totalManualAdjustmentCredits).toBe(BigInt(10));
      expect(health.totalManualAdjustmentDebits).toBe(BigInt(4));
      expect(health.netManualAdjustmentPoints).toBe(BigInt(6));
      expect(health.totalPointsRedeemed).toBe(BigInt(7));
      expect(health.netOutstandingPoints).toBe(BigInt(121));
    });

    it("computes 0% redemption and 100% breakage when no points have been redeemed", async () => {
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
            pointsDelta: BigInt(100000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any,
      );

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.totalPointsEarned).toBe(BigInt(100000));
      expect(health.totalPointsRedeemed).toBe(BigInt(0));
      expect(health.redemptionRate).toBe(0);
      expect(health.breakageRate).toBe(100);
      expect(health.netOutstandingPoints).toBe(BigInt(100000));
    });

    it("computes 40% redemption and 60% breakage with mixed earn, redeem, and refund entries", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(5000),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(100000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            pointsDelta: BigInt(-40000),
            entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          },
          {
            pointsDelta: BigInt(-5000),
            entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
          },
          {
            pointsDelta: BigInt(-2000),
            entryType: WeleticPointsLedgerEntryType.EXPIRATION,
          },
        ] as any,
      );

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.totalPointsEarned).toBe(BigInt(100000));
      expect(health.totalPointsRedeemed).toBe(BigInt(40000));
      expect(health.totalPointsRefundReversed).toBe(BigInt(5000));
      expect(health.totalPointsExpired).toBe(BigInt(2000));
      expect(health.redemptionRate).toBe(40.0);
      expect(health.breakageRate).toBe(60.0);
      // Net outstanding: 100,000 - 40,000 - 5,000 - 2,000 = 53,000
      expect(health.netOutstandingPoints).toBe(BigInt(53000));
    });

    it("computes 100% redemption and 0% breakage safely without division by zero", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(50000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            pointsDelta: BigInt(-50000),
            entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          },
        ] as any,
      );

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.redemptionRate).toBe(100.0);
      expect(health.breakageRate).toBe(0.0);
      expect(health.netOutstandingPoints).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // 5. Referral Economics Matrix (CAC, ROI, Multipliers)
  // =========================================================================
  describe("5. Referral Program Economics Matrix", () => {
    it("calculates advocate and referee reward point splits with exact CAC and ROI", () => {
      // 20 total referrals, 10 successful conversions (50% conversion rate)
      // Total reward points awarded: 10,000 points @ $0.01 = $100.00 cost (10,000 cents)
      // Attributed revenue: $800.00 (80,000 cents)
      const eco = calculateReferralEconomics({
        totalReferrals: 20,
        successfulReferrals: 10,
        totalRewardPoints: BigInt(10000),
        revenueMinorUnits: BigInt(80000),
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(eco.totalReferrals).toBe(20);
      expect(eco.successfulReferrals).toBe(10);
      expect(eco.referralConversionRate).toBe(50.0);
      expect(eco.referralRewardCostMinorUnits).toBe(BigInt(10000));
      expect(eco.referralCACMinorUnits).toBe(BigInt(1000)); // 10,000 / 10 = 1,000 cents ($10.00)
      expect(eco.referralCAC).toBe(10.0);
      // Net ROI: ((80,000 - 10,000) / 10,000) * 100 = 700.0%
      expect(eco.referralROI).toBe(700.0);
      // Multiplier: 80,000 / 10,000 = 8.0x
      expect(eco.referralROIMultiplier).toBe(8.0);
    });

    it("handles referee-only zero-revenue initial referral grant", () => {
      const eco = calculateReferralEconomics({
        totalReferrals: 5,
        successfulReferrals: 5,
        totalRewardPoints: BigInt(2500),
        revenueMinorUnits: BigInt(0),
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(eco.referralConversionRate).toBe(100.0);
      expect(eco.referralRewardCostMinorUnits).toBe(BigInt(2500));
      expect(eco.referralCACMinorUnits).toBe(BigInt(500)); // 500 cents ($5.00)
      expect(eco.referralCAC).toBe(5.0);
      expect(eco.referralROI).toBe(-100.0); // -100% ROI on 0 revenue
      expect(eco.referralROIMultiplier).toBe(0.0);
    });

    it("preserves exact decimal strings for values beyond safe integers", () => {
      const points = BigInt("1000000000000000000000000000000");
      const eco = calculateReferralEconomics({
        totalReferrals: 3,
        successfulReferrals: 3,
        totalRewardPoints: points,
        revenueMinorUnits: BigInt("100000000000000000000000000000000"),
        currency: "USD",
        liabilityMinorUnitsNumerator: BigInt(3),
        liabilityPointsDenominator: BigInt(7),
      });

      expect(eco.referralRewardCostMinorUnits).toBe(
        (points * BigInt(3) + BigInt(6)) / BigInt(7),
      );
      expect(eco.referralCACDecimal).toBe(
        "1428571428571428571428571428.57142857",
      );
      expect(eco.referralROIDecimal).toBe("23233.333333");
      expect(eco.referralROIMultiplierDecimal).toBe("233.333333");
    });

    it("fails referral financial metrics closed on accounting-currency mismatch", async () => {
      const dataQuality = evaluateOrderCurrencyDataQuality(
        [{ accountingCurrency: "EUR" }],
        "USD",
      );
      const pure = calculateReferralEconomics({
        totalReferrals: 1,
        successfulReferrals: 1,
        totalRewardPoints: BigInt(100),
        revenueMinorUnits: BigInt(10000),
        currency: "USD",
        dataQuality,
      });
      expect(pure.referralRewardCostMinorUnits).toBeNull();
      expect(pure.referralRevenueMinorUnits).toBeNull();
      expect(pure.referralROIReason).toMatch(/configured accounting currency/);

      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce([
        {
          id: "ref_mismatch",
          status: "rewarded",
          advocatePointsAwarded: BigInt(100),
          refereePointsAwarded: BigInt(0),
          qualifyingOrderId: "order_mismatch",
        },
      ] as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "order_mismatch",
          accountingCurrency: "EUR",
          accountingNet: BigInt(10000),
        },
      ] as any);

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.financialDataQuality.status).toBe("data_quality_error");
      expect(health.financialDataQuality.mismatchedOrderCount).toBe(1);
      expect(health.referralRewardCostMinorUnits).toBeNull();
      expect(health.referralRevenueMinorUnits).toBeNull();
      expect(health.referralROI).toBeNull();
    });

    it("fails referral financial metrics closed when an attributed order is missing", async () => {
      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce([
        {
          id: "ref_missing_order",
          status: "rewarded",
          advocatePointsAwarded: BigInt(100),
          refereePointsAwarded: BigInt(50),
          qualifyingOrderId: null,
        },
      ] as any);

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.financialDataQuality.status).toBe("data_quality_error");
      expect(health.financialDataQuality.missingOrderCount).toBe(1);
      expect(health.referralRevenueMinorUnits).toBeNull();
      expect(health.referralROI).toBeNull();
      expect(prisma.weleticCommerceOrder.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. Member vs Non-Member Cohort Attribution Matrix (AOV, Repeat Rate, LTV, Lift)
  // =========================================================================
  describe("6. Member vs Non-Member Cohort Attribution Matrix", () => {
    it("computes deterministic AOV, repeat purchase rate, and LTV with relative lift percentages", () => {
      const memberShopperIds = new Set([
        "shopper_m1",
        "shopper_m2",
        "shopper_m3",
        "shopper_m4",
      ]);

      const orders = [
        // Member M1: 3 orders ($100 each = $300)
        { shopperId: "shopper_m1", totalMinorUnits: BigInt(10000) },
        { shopperId: "shopper_m1", totalMinorUnits: BigInt(10000) },
        { shopperId: "shopper_m1", totalMinorUnits: BigInt(10000) },
        // Member M2: 4 orders ($100 each = $400)
        { shopperId: "shopper_m2", totalMinorUnits: BigInt(10000) },
        { shopperId: "shopper_m2", totalMinorUnits: BigInt(10000) },
        { shopperId: "shopper_m2", totalMinorUnits: BigInt(10000) },
        { shopperId: "shopper_m2", totalMinorUnits: BigInt(10000) },
        // Member M3: 2 orders ($100 each = $200)
        { shopperId: "shopper_m3", totalMinorUnits: BigInt(10000) },
        { shopperId: "shopper_m3", totalMinorUnits: BigInt(10000) },
        // Member M4: 1 order ($100 = $100)
        { shopperId: "shopper_m4", totalMinorUnits: BigInt(10000) },

        // Non-Member N1: 2 orders ($50 each = $100)
        { shopperId: "shopper_n1", totalMinorUnits: BigInt(5000) },
        { shopperId: "shopper_n1", totalMinorUnits: BigInt(5000) },
        // Non-Member N2: 1 order ($50)
        { shopperId: "shopper_n2", totalMinorUnits: BigInt(5000) },
        // Non-Member N3: 1 order ($50)
        { shopperId: "shopper_n3", totalMinorUnits: BigInt(5000) },
        // Non-Member N4: 1 order ($50)
        { shopperId: "shopper_n4", totalMinorUnits: BigInt(5000) },
        // Non-Member N5: 1 order ($50)
        { shopperId: "shopper_n5", totalMinorUnits: BigInt(5000) },
      ];

      const { members, nonMembers, lift } = calculateCohortMetricsPure(
        orders,
        memberShopperIds,
        "USD",
      );

      // Members Verification:
      // Unique customers = 4
      // Total orders = 10
      // Total spend = 100,000 cents ($1,000.00)
      // Repeat purchasers = 3 (M1, M2, M3 have >= 2 orders)
      // Repeat purchase rate = (3 / 4) * 100 = 75.0%
      // AOV = 100,000 / 10 = 10,000 cents ($100.00)
      // LTV = 100,000 / 4 = 25,000 cents ($250.00)
      expect(members.customerCount).toBe(4);
      expect(members.totalOrders).toBe(10);
      expect(members.totalSpendMinorUnits).toBe(BigInt(100000));
      expect(members.totalSpendDecimal).toBe("1000.00");
      expect(members.repeatPurchaserCount).toBe(3);
      expect(members.repeatPurchaseRate).toBe(75.0);
      expect(members.aovMinorUnits).toBe(BigInt(10000));
      expect(members.aovDecimal).toBe("100.00");
      expect(members.ltvMinorUnits).toBe(BigInt(25000));
      expect(members.ltvDecimal).toBe("250.00");

      // Non-Members Verification:
      // Unique customers = 5
      // Total orders = 6
      // Total spend = 30,000 cents ($300.00)
      // Repeat purchasers = 1 (N1 has 2 orders)
      // Repeat purchase rate = (1 / 5) * 100 = 20.0%
      // AOV = 30,000 / 6 = 5,000 cents ($50.00)
      // LTV = 30,000 / 5 = 6,000 cents ($60.00)
      expect(nonMembers.customerCount).toBe(5);
      expect(nonMembers.totalOrders).toBe(6);
      expect(nonMembers.totalSpendMinorUnits).toBe(BigInt(30000));
      expect(nonMembers.totalSpendDecimal).toBe("300.00");
      expect(nonMembers.repeatPurchaserCount).toBe(1);
      expect(nonMembers.repeatPurchaseRate).toBe(20.0);
      expect(nonMembers.aovMinorUnits).toBe(BigInt(5000));
      expect(nonMembers.aovDecimal).toBe("50.00");
      expect(nonMembers.ltvMinorUnits).toBe(BigInt(6000));
      expect(nonMembers.ltvDecimal).toBe("60.00");

      // Lift Comparison Verification:
      // AOV Lift: ((100 - 50) / 50) * 100 = +100.0%
      // Repeat Rate Lift: 75.0% - 20.0% = +55.0%
      // LTV Lift: ((250 - 60) / 60) * 100 = +316.7%
      expect(lift.aovLiftPercentage).toBe(100.0);
      expect(lift.repeatPurchaseRateLiftPercentage).toBe(55.0);
      expect(lift.ltvLiftPercentage).toBe(316.7);
    });

    it("keeps fractional-minor-unit cohort averages and lifts in integer rational arithmetic", () => {
      const { members, nonMembers, lift } = calculateCohortMetricsPure(
        [
          { shopperId: "member", totalMinorUnits: BigInt(1) },
          { shopperId: "member", totalMinorUnits: BigInt(0) },
          { shopperId: "guest", totalMinorUnits: BigInt(1) },
          { shopperId: "guest", totalMinorUnits: BigInt(1) },
          { shopperId: "guest", totalMinorUnits: BigInt(1) },
        ],
        new Set(["member"]),
        "USD",
      );

      expect(members.aovMinorUnits).toBe(BigInt(0));
      expect(members.aovDecimal).toBe("0.005");
      expect(nonMembers.aovDecimal).toBe("0.01");
      expect(lift.aovLiftPercentage).toBe(-50);
    });

    it("evaluates calculateMemberCohortAttribution with database queries", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        { shopperId: "sh_mem_1" },
      ] as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "ord_1",
          shopperId: "sh_mem_1",
          accountingCurrency: "USD",
          accountingTotal: BigInt(12000), // $120.00
          status: "paid",
        },
        {
          id: "ord_2",
          shopperId: "sh_guest_2",
          accountingCurrency: "USD",
          accountingTotal: BigInt(6000), // $60.00
          status: "paid",
        },
      ] as any);

      const result = await calculateMemberCohortAttribution({
        storeId,
        currency: "USD",
      });

      expect(result.storeId).toBe(storeId);
      expect(result.currency).toBe("USD");
      expect(result.members.customerCount).toBe(1);
      expect(result.members.totalSpendDecimal).toBe("120.00");
      expect(result.nonMembers.customerCount).toBe(1);
      expect(result.nonMembers.totalSpendDecimal).toBe("60.00");
      expect(result.lift.aovLiftPercentage).toBe(100.0);
      expect(result.dataQuality.status).toBe("available");
    });

    it("returns cohort counts but no monetary values on currency mismatch", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        { shopperId: "sh_mem_1" },
      ] as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "ord_eur",
          shopperId: "sh_mem_1",
          accountingCurrency: "EUR",
          accountingTotal: BigInt(12000),
          status: "paid",
        },
      ] as any);

      const result = await calculateMemberCohortAttribution({
        storeId,
        currency: "USD",
      });

      expect(result.members.customerCount).toBe(1);
      expect(result.members.totalSpendMinorUnits).toBeNull();
      expect(result.members.aovDecimal).toBeNull();
      expect(result.lift.aovLiftPercentage).toBeNull();
      expect(result.dataQuality.status).toBe("data_quality_error");
    });
  });

  // =========================================================================
  // 7. Owner-Only Export Matrix (JSON, CSV, Formula Defense, Zero PII, RBAC)
  // =========================================================================
  describe("7. Owner-Only Export Matrix (JSON, CSV, Formula Defense, Zero PII, RBAC)", () => {
    it("enforces strict owner RBAC and rejects non-owner callers", async () => {
      await expect(
        exportLoyaltyMetricsJson({
          storeId,
          callerRole: "admin",
        }),
      ).rejects.toThrow(/Unauthorized: Only store owners/);

      await expect(
        exportLoyaltyMetricsCsv({
          storeId,
          callerRole: "member",
        }),
      ).rejects.toThrow(/Unauthorized: Only store owners/);

      await expect(
        exportLoyaltyMetricsJson({
          storeId,
          callerRole: undefined as any,
        }),
      ).rejects.toThrow(/Unauthorized: Only store owners/);
    });

    it("successfully generates owner JSON export with clean BigInt serialization", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        {
          id: "acc_1",
          shopperId: "sh_alpha",
          cachedPointsBalance: BigInt(2500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const result = await exportLoyaltyMetricsJson({
        storeId,
        callerRole: "owner",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
        includeMembersSample: true,
      });

      expect(result.storeId).toBe(storeId);
      expect(result.callerRole).toBe("owner");
      expect(result.liability.totalCirculatingPoints).toBe(BigInt(2500));
      expect(result.liability.totalLiabilityDecimal).toBe("25.00");

      // Verify serialization safety: JSON.stringify must not throw on BigInt!
      const jsonStr = JSON.stringify(result);
      expect(typeof jsonStr).toBe("string");
      const parsed = JSON.parse(jsonStr);
      expect(parsed.liability.totalLiabilityDecimal).toBe("25.00");
    });

    it("scrubs PII into cryptographic digests and neutralizes CSV formula injection attacks", async () => {
      // Injected malicious formula names / customer emails
      const maliciousFormula = "=cmd|' /C calc'!A0";
      const customerEmail = "victim@example.com";

      // 1. Verify formula injection defense via escapeCsvUntrustedTextCell
      const escapedFormula = escapeCsvUntrustedTextCell(maliciousFormula);
      expect(escapedFormula.startsWith("'=")).toBe(true);

      const escapedSum = escapeCsvUntrustedTextCell("@SUM()");
      expect(escapedSum.startsWith("'@")).toBe(true);

      const escapedPlus = escapeCsvUntrustedTextCell("+12345");
      expect(escapedPlus.startsWith("'+")).toBe(true);

      const escapedMinus = escapeCsvUntrustedTextCell("-9999");
      expect(escapedMinus.startsWith("'-")).toBe(true);

      // 2. Verify zero-PII cryptographic digest
      const scrubbed = scrubPiiToCryptographicDigest(customerEmail);
      expect(scrubbed).toMatch(/^anon_[a-f0-9]{16}$/);
      expect(scrubbed).not.toContain("@");
      expect(scrubbed).not.toContain("victim");
      expect(scrubbed).not.toContain("example.com");

      // 3. Verify complete CSV generation with sample members
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        {
          id: "acc_attack",
          shopperId: customerEmail,
          cachedPointsBalance: BigInt(1000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const csv = await exportLoyaltyMetricsCsv({
        storeId,
        callerRole: "owner",
        currency: "USD",
        includeMembersSample: true,
      });

      expect(typeof csv).toBe("string");
      expect(csv).toContain("Section,Property,Value");
      expect(csv).toContain("Metadata,Caller Role,owner");
      expect(csv).toContain("Liability,Total Financial Liability");
      expect(csv).not.toContain("victim@example.com");
      expect(csv).not.toContain("@example.com");
      expect(csv).toContain(scrubbed);
    });
  });
});
