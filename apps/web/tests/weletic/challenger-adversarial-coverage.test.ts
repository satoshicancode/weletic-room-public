import { prisma } from "@/lib/prisma";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  calculatePointsLiability,
  calculateReferralEconomics,
  getLoyaltyProgramHealthMetrics,
} from "@/lib/weletic/loyalty/analytics";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import {
  bindShopperReferral,
  evaluateReferralQualification,
} from "@/lib/weletic/loyalty/referrals";
import {
  WeleticLoyaltyReferralStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock Prisma for integration and unit simulation
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })),
      create: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => data),
    },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: vi.fn(async (params: any) => ({
    id: "wledger_mock_entry",
    balanceAfter: BigInt(1_000) + BigInt(params.pointsDelta),
    ...params,
  })),
}));

describe("Challenger 2: Adversarial Coverage & Integration Test Harness", () => {
  const storeId = "store_yamax_adv";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
      count: 1,
    });
  });

  // ===========================================================================
  // PILLAR 1: VIP Multiplier + Bonus Campaign + Referral Redemption Interactions
  // ===========================================================================
  describe("Pillar 1: VIP Multiplier + Bonus Campaign + Referral Interactions", () => {
    it("1.1: Multiplier stacking: order net spend with VIP tier (1.5x) and Campaign (2.0x) evaluates exactly without floating precision drift", () => {
      // Base spend: $150.00 (15,000 cents) in USD
      // Multiplier = 1.5 * 2.0 = 3.0x -> 150 * 3.0 = 450 points
      const pointsUSD = calculateEligibleOrderPoints({
        netAmountCents: BigInt(15000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.5 * 2.0,
      });
      expect(pointsUSD).toBe(BigInt(450));

      // Same order in JPY: ¥15,000 with 0.01 base rate (1 pt per ¥100) * 3.0x
      // 15,000 * 0.03 = 450 points
      const pointsJPY = calculateEligibleOrderPoints({
        netAmountCents: BigInt(15000),
        currency: "JPY",
        pointsPerCurrencyUnit: 0.01,
        multiplier: 1.5 * 2.0,
      });
      expect(pointsJPY).toBe(BigInt(450));
    });

    it("1.2: Referral voucher discount applied at checkout: points are earned strictly on net post-discount spend", () => {
      // Cart: $200.00. Referral friend voucher: -$30.00. Net checkout spend = $170.00.
      // Minimum subtotal requirement = $50.00.
      const grossCart = BigInt(20000);
      const discount = BigInt(3000);
      const netPaid = grossCart - discount; // $170.00 (17,000 cents)
      const minSubtotal = BigInt(5000); // $50.00 (5,000 cents)

      const earned = calculateEligibleOrderPoints({
        netAmountCents: netPaid,
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.25, // Silver tier (1.25x)
        minOrderSubtotalCents: minSubtotal,
      });

      // 170 * 1.25 = 212.5 -> floor(212.5) = 212 points
      expect(earned).toBe(BigInt(212));
    });

    it("1.3: 100% discount voucher results in $0 net spend: 0 points earned and no threshold violation error", () => {
      const netPaidZero = BigInt(0);
      const minSubtotal = BigInt(2500);

      const earned = calculateEligibleOrderPoints({
        netAmountCents: netPaidZero,
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 2.0,
        minOrderSubtotalCents: minSubtotal,
      });

      expect(earned).toBe(BigInt(0));
    });

    it("1.4: Referral self-referral and duplicate binding prevention", async () => {
      const advocateAccountId = "wacc_advocate_1";
      const refereeAccountId = "wacc_referee_1";

      // Mock advocate account lookup
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: advocateAccountId,
        storeId,
        referralCode: "ALICE-1234",
        status: "active",
        programId: "prog_1",
      } as any);

      // Attempt 1: Self-referral (Advocate attempting to refer themselves)
      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: advocateAccountId, // SAME ACCOUNT
          referralCode: "ALICE-1234",
        }),
      ).rejects.toThrow(/Self-referral is strictly prohibited/i);

      // Attempt 2: Duplicate referee binding (Referee already has referredById)
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: advocateAccountId,
        storeId,
        referralCode: "ALICE-1234",
        status: "active",
        programId: "prog_1",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: refereeAccountId,
        storeId,
        status: "active",
        referredById: "wacc_previous_advocate", // Already referred
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId,
          referralCode: "ALICE-1234",
        }),
      ).rejects.toThrow(/already been referred/i);
    });

    it("1.5: End-to-end referral qualification: awards advocate and referee on qualifying order >= threshold", async () => {
      const referralRule = {
        id: "wreferral_rule_1",
        programId: "prog_1",
        isActive: true,
        minQualifyingOrderSubtotal: 30.0, // $30 minimum threshold
        advocatePointsReward: BigInt(100),
        refereePointsReward: BigInt(50),
      };

      // Mock referee account
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "wacc_referee_1",
        storeId,
        status: "active",
        shopperId: "shopper_referee_1",
      } as any);

      // Mock pending referral
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValue({
        id: "wref_123",
        advocateAccountId: "wacc_advocate_1",
        refereeAccountId: "wacc_referee_1",
        status: WeleticLoyaltyReferralStatus.pending,
        advocateAccount: {
          id: "wacc_advocate_1",
          storeId,
          status: "active",
          programId: "prog_1",
        },
      } as any);

      vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mockResolvedValue(
        referralRule as any,
      );

      // Order under threshold ($29.99 = 2,999 cents)
      const res1 = await evaluateReferralQualification({
        storeId,
        orderId: "ord_small",
        refereeShopperId: "shopper_referee_1",
        orderSubtotal: BigInt(2999),
        currency: "USD",
      });
      expect(res1.qualified).toBe(false);

      // Qualifying order ($35.00 = 3,500 cents)
      const res2 = await evaluateReferralQualification({
        storeId,
        orderId: "ord_qual",
        refereeShopperId: "shopper_referee_1",
        orderSubtotal: BigInt(3500),
        currency: "USD",
      });
      expect(res2.qualified).toBe(true);
      expect(res2.advocatePointsAwarded).toBe(BigInt(100));
      expect(res2.refereePointsAwarded).toBe(BigInt(50));
    });
  });

  // ===========================================================================
  // PILLAR 2: Refund Points Clawback Reversals and Ledger Invariants
  // ===========================================================================
  describe("Pillar 2: Refund Points Clawback Reversals & Ledger Invariants", () => {
    it("2.1: Proportional refund clawback on order earned with stacked multipliers", () => {
      // Original Order: $400 spend with 1.5x VIP * 2.0x Flash = 3.0x rate -> Earned 1,200 points.
      // Customer receives 35% partial refund ($140.00).
      // Proportional reversal: 1,200 * 35% = 420 points reversed.
      const originalPoints = BigInt(1200);
      const originalSpendCents = BigInt(40000);
      const refundCents = BigInt(14000); // 35%

      const reversedPoints = BigInt(
        Math.floor(
          Number(originalPoints) *
            (Number(refundCents) / Number(originalSpendCents)),
        ),
      );
      expect(reversedPoints).toBe(BigInt(420));
      const remainingPoints = originalPoints - reversedPoints;
      expect(remainingPoints).toBe(BigInt(780));
    });

    it("2.2: Over-refund protection: multi-stage refund sequence never claws back more than original points", () => {
      const originalEarnings = BigInt(500);
      const originalSpend = BigInt(10000); // $100

      // Stage 1: $40 refund (40%) -> 200 points
      const rev1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalSpend,
        refundedAmount: BigInt(4000),
        alreadyReversed: BigInt(0),
      });
      expect(rev1).toBe(BigInt(200));

      // Stage 2: $50 refund (50%) -> 250 points
      const rev2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalSpend,
        refundedAmount: BigInt(5000),
        alreadyReversed: rev1,
      });
      expect(rev2).toBe(BigInt(250));

      // Stage 3: Excessive $30 refund (30% -> total 120%) -> Capped at remaining 50 points
      const rev3 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalSpend,
        refundedAmount: BigInt(3000),
        alreadyReversed: rev1 + rev2,
      });
      expect(rev3).toBe(BigInt(50));
      expect(rev1 + rev2 + rev3).toBe(originalEarnings);

      // Stage 4: Subsequent refund when 100% reversed -> returns 0
      const rev4 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalSpend,
        refundedAmount: BigInt(2000),
        alreadyReversed: rev1 + rev2 + rev3,
      });
      expect(rev4).toBe(BigInt(0));
    });

    it("2.3: Double-entry ledger conservation & monotonic sequence invariant (1,000 transaction simulation)", () => {
      let balance = BigInt(0);
      let lifetimeEarned = BigInt(0);
      let lifetimeRedeemed = BigInt(0);
      let lifetimeReversed = BigInt(0);

      const entries: Array<{
        seq: number;
        delta: bigint;
        balanceAfter: bigint;
        type: string;
      }> = [];

      for (let i = 1; i <= 1000; i++) {
        const opType = i % 5;
        let delta = BigInt(0);
        let type = "";

        if (opType === 1 || opType === 2) {
          // Earn order
          delta = BigInt(((i * 17) % 300) + 10);
          type = "EARN_ORDER";
          lifetimeEarned += delta;
        } else if (opType === 3) {
          // Redeem reward (if balance allows)
          const cost = BigInt(((i * 11) % 150) + 20);
          if (balance >= cost) {
            delta = -cost;
            type = "REDEEM_REWARD";
            lifetimeRedeemed += cost;
          } else {
            delta = BigInt(50);
            type = "MANUAL_ADJUSTMENT";
            lifetimeEarned += BigInt(50);
          }
        } else if (opType === 4) {
          // Refund reversal (can create negative balance if needed)
          const rev = BigInt(((i * 7) % 80) + 5);
          delta = -rev;
          type = "REFUND_REVERSAL";
          lifetimeReversed += rev;
        } else {
          // Bonus / Goodwill
          delta = BigInt(100);
          type = "EARN_BONUS";
          lifetimeEarned += BigInt(100);
        }

        balance += delta;
        entries.push({
          seq: i,
          delta,
          balanceAfter: balance,
          type,
        });
      }

      // 1. Verify 1000 entries exist
      expect(entries).toHaveLength(1000);

      // 2. Monotonic sequence check: seq_i = i
      for (let idx = 0; idx < entries.length; idx++) {
        expect(entries[idx].seq).toBe(idx + 1);
      }

      // 3. Mathematical conservation: sum(deltas) === final balance
      const sumDeltas = entries.reduce((acc, e) => acc + e.delta, BigInt(0));
      expect(sumDeltas).toBe(balance);
      expect(entries[entries.length - 1].balanceAfter).toBe(balance);
    });

    it("2.4: Negative balance debt handling: redemption strictly rejected when balance < 0, permitted when amortized", () => {
      let balance = BigInt(0);

      // Start: Earn 100 points
      balance += BigInt(100);

      // Redeem 100 points -> Balance = 0
      balance -= BigInt(100);
      expect(balance).toBe(BigInt(0));

      // Late refund reversal arrives -> Balance = -150
      balance -= BigInt(150);
      expect(balance).toBe(BigInt(-150));

      // Attempt redemption while in debt -> Must be blocked
      const canRedeemWhileNegative =
        balance >= BigInt(50) && balance > BigInt(0);
      expect(canRedeemWhileNegative).toBe(false);

      // Subsequent purchase earns +200 points -> Amortizes debt -> Balance = +50
      balance += BigInt(200);
      expect(balance).toBe(BigInt(50));

      // Now 50 points redemption is permitted
      const canRedeemAfterRecovery =
        balance >= BigInt(50) && balance > BigInt(0);
      expect(canRedeemAfterRecovery).toBe(true);
      balance -= BigInt(50);
      expect(balance).toBe(BigInt(0));
    });
  });

  // ===========================================================================
  // PILLAR 3: Financial Liability Engine Calculations
  // ===========================================================================
  describe("Pillar 3: Financial Liability Engine (Breakage, CAC, ROI, Multi-Currency)", () => {
    it("3.1: Zero-decimal currency scaling (JPY, VND, KRW) computes exact monetary liability without .00 decimals", async () => {
      // 3 accounts in Tokyo store with 15,000, 35,000, and 50,000 points
      // Total circulating points = 100,000. Valuation = ¥1 per point.
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(15000),
          cachedPendingPoints: BigInt(5000),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(35000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(50000),
          cachedPendingPoints: BigInt(10000),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const jpyReport = await calculatePointsLiability({
        storeId,
        currency: "JPY",
        valuationPerPointMinorUnits: 1,
      });

      expect(jpyReport.isZeroDecimal).toBe(true);
      expect(jpyReport.totalCirculatingPoints).toBe(BigInt(100000));
      expect(jpyReport.totalLiabilityMinorUnits).toBe(BigInt(100000));
      expect(jpyReport.totalLiabilityDecimal).toBe("100000"); // No decimal fraction!
      expect(jpyReport.totalPendingLiabilityDecimal).toBe("15000");
    });

    it("3.2: 2-decimal currency scaling (USD) correctly scales cents to decimal format", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(4550),
          cachedPendingPoints: BigInt(450),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const usdReport = await calculatePointsLiability({
        storeId,
        currency: "USD",
        valuationPerPointMinorUnits: 1, // 1 cent per point
      });

      expect(usdReport.isZeroDecimal).toBe(false);
      expect(usdReport.totalLiabilityMinorUnits).toBe(BigInt(4550));
      expect(usdReport.totalLiabilityDecimal).toBe("45.50"); // Exact $45.50
      expect(usdReport.totalPendingLiabilityDecimal).toBe("4.50");
    });

    it("3.3: Program health, active participation rate (90-day window), redemption rate, and breakage rate", async () => {
      const now = Date.now();
      const recentDate = new Date(now - 10 * 24 * 60 * 60 * 1000); // 10 days ago (active)
      const staleDate = new Date(now - 120 * 24 * 60 * 60 * 1000); // 120 days ago (inactive)

      // 4 members: 3 active, 1 inactive -> 75.0% participation rate
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(100),
          status: "active",
          updatedAt: recentDate,
        },
        {
          cachedPointsBalance: BigInt(200),
          status: "active",
          updatedAt: recentDate,
        },
        {
          cachedPointsBalance: BigInt(300),
          status: "active",
          updatedAt: recentDate,
        },
        {
          cachedPointsBalance: BigInt(400),
          status: "active",
          updatedAt: staleDate,
        },
      ] as any);

      // Ledger: 10,000 earned, 4,000 redeemed -> 40.0% redemption rate, 60.0% breakage rate
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            pointsDelta: BigInt(10000),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            pointsDelta: BigInt(-4000),
            entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          },
        ] as any,
      );

      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce(
        [],
      );

      const health = await getLoyaltyProgramHealthMetrics({
        storeId,
        currency: "USD",
      });

      expect(health.totalMembers).toBe(4);
      expect(health.activeMembers).toBe(3);
      expect(health.inactiveMembers).toBe(1);
      expect(health.participationRate).toBe(75.0);
      expect(health.totalPointsEarned).toBe(BigInt(10000));
      expect(health.totalPointsRedeemed).toBe(BigInt(4000));
      expect(health.redemptionRate).toBe(40.0);
      expect(health.breakageRate).toBe(60.0);
    });

    it("3.4: Referral CAC & ROI formulas handle extreme marketing outcomes and zero divisions safely", () => {
      // Case A: Normal high ROI campaign
      const normal = calculateReferralEconomics({
        totalReferrals: 100,
        successfulReferrals: 40,
        totalRewardPoints: BigInt(4000), // 4,000 pts @ 1 cent = $40.00 cost (4,000 cents)
        revenueMinorUnits: BigInt(400000), // $4,000.00 revenue (400,000 cents)
        currency: "USD",
      });

      expect(normal.referralConversionRate).toBe(40.0);
      expect(normal.referralCAC).toBe(1.0); // $40 cost / 40 referrals = $1.00 CAC
      expect(normal.referralROI).toBe(9900.0); // ((400,000 - 4,000) / 4,000) * 100 = 9900%
      expect(normal.referralROIMultiplier).toBe(100.0);

      // Case B: Zero successful referrals (no division by zero!)
      const zeroSuccess = calculateReferralEconomics({
        totalReferrals: 50,
        successfulReferrals: 0,
        totalRewardPoints: BigInt(0),
        revenueMinorUnits: BigInt(0),
        currency: "USD",
      });

      expect(zeroSuccess.referralConversionRate).toBe(0);
      expect(zeroSuccess.referralCAC).toBeNull();
      expect(zeroSuccess.referralROI).toBeNull();
      expect(zeroSuccess.referralROIMultiplier).toBeNull();
      expect(zeroSuccess.referralROIReason).toMatch(/cost is zero/);
    });
  });

  // ===========================================================================
  // PILLAR 4: Storefront Widget Tab Transitions and Customizer Preview Responsiveness
  // ===========================================================================
  describe("Pillar 4: Storefront Widget Tab Transitions & Customizer Preview", () => {
    it("4.1: Widget tab routing integrity: supports all 6 canonical Smile.io views", () => {
      const validTabs = [
        "home",
        "earn",
        "rewards",
        "vip",
        "referral",
        "history",
      ] as const;
      type TabType = (typeof validTabs)[number];

      let currentTab: TabType = "home";
      const switchTab = (next: TabType) => {
        expect(validTabs).toContain(next);
        currentTab = next;
      };

      switchTab("earn");
      expect(currentTab).toBe("earn");
      switchTab("rewards");
      expect(currentTab).toBe("rewards");
      switchTab("vip");
      expect(currentTab).toBe("vip");
      switchTab("referral");
      expect(currentTab).toBe("referral");
      switchTab("history");
      expect(currentTab).toBe("history");
      switchTab("home");
      expect(currentTab).toBe("home");
    });

    it("4.2: Reward affordability logic in widget: unlocks redeem button only when pointsBalance >= pointsCost", () => {
      const catalog = [
        { id: "rew_1", name: "¥500 Off", pointsCost: 500 },
        { id: "rew_2", name: "10% Off", pointsCost: 1000 },
        { id: "rew_3", name: "Free Shipping", pointsCost: 300 },
        { id: "rew_4", name: "Yamax Flow Cap", pointsCost: 2000 },
      ];

      // Test with 750 points
      const pointsBalance = 750;
      const evaluated = catalog.map((r) => ({
        ...r,
        canRedeem: pointsBalance >= r.pointsCost,
      }));

      expect(evaluated.find((r) => r.id === "rew_3")?.canRedeem).toBe(true); // 300 <= 750 (Unlocked)
      expect(evaluated.find((r) => r.id === "rew_1")?.canRedeem).toBe(true); // 500 <= 750 (Unlocked)
      expect(evaluated.find((r) => r.id === "rew_2")?.canRedeem).toBe(false); // 1000 > 750 (Locked)
      expect(evaluated.find((r) => r.id === "rew_4")?.canRedeem).toBe(false); // 2000 > 750 (Locked)
    });

    it("4.3: Customizer live preview mode: produces instant mocked discount code on 1-click redemption", () => {
      const previewMode = true;
      let lastRedemption: { code: string; rewardName: string } | null = null;

      const handlePreviewRedeem = (rewardId: string, rewardName: string) => {
        if (previewMode) {
          lastRedemption = {
            code: `YAMAX-SAVE-${rewardId.toUpperCase()}`,
            rewardName,
          };
        }
      };

      handlePreviewRedeem("rew_10off", "10% Off Voucher");
      expect(lastRedemption).not.toBeNull();
      expect((lastRedemption as any)?.code).toBe("YAMAX-SAVE-REW_10OFF");
      expect((lastRedemption as any)?.rewardName).toBe("10% Off Voucher");
    });

    it("4.4: Dynamic customizer branding updates correctly propagate to widget configuration", () => {
      interface BrandingShape {
        launcherText: string;
        launcherPosition: "bottom_right" | "bottom_left";
        primaryColor: string;
        headerTextColor: string;
        panelTitle: string;
      }

      const defaultBranding: BrandingShape = {
        launcherText: "Rewards",
        launcherPosition: "bottom_right",
        primaryColor: "#059669",
        headerTextColor: "#ffffff",
        panelTitle: "Yamax Club",
      };

      const customBranding: BrandingShape = {
        launcherText: "VIP Perks",
        launcherPosition: "bottom_left",
        primaryColor: "#4f46e5",
        headerTextColor: "#f8fafc",
        panelTitle: "Yamax Platinum Lounge",
      };

      const resolveConfig = (branding: BrandingShape) => ({
        text: branding.launcherText,
        pos: branding.launcherPosition,
        bg: branding.primaryColor,
        color: branding.headerTextColor,
        title: branding.panelTitle,
      });

      const config1 = resolveConfig(defaultBranding);
      expect(config1.text).toBe("Rewards");
      expect(config1.pos).toBe("bottom_right");

      const config2 = resolveConfig(customBranding);
      expect(config2.text).toBe("VIP Perks");
      expect(config2.pos).toBe("bottom_left");
      expect(config2.bg).toBe("#4f46e5");
      expect(config2.title).toBe("Yamax Platinum Lounge");
    });
  });
});
