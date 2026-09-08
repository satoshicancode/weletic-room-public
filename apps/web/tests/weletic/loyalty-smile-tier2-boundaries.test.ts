import { prisma } from "@/lib/prisma";
import { calculatePointsLiability } from "@/lib/weletic/loyalty/analytics";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { buildCustomerMetafieldUpdates } from "@/lib/weletic/loyalty/metafield-sync";
import { checkBirthdayEligibility } from "@/lib/weletic/loyalty/non-purchase-earn";
import { redeemReward } from "@/lib/weletic/loyalty/rewards";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  WeleticPointsLedgerEntryType,
  WeleticRewardStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
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

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Tier 2: Boundary & Corner Cases Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // BOUNDARY 1: 0-Decimal Currency Scaling (JPY, VND, KRW, etc.)
  // ===========================================================================
  describe("Boundary 1: Zero-Decimal Currency Scaling vs 2-Decimal", () => {
    it("2.1.1: calculates points in JPY (0-decimal) without dividing by 100", () => {
      // ¥10,000 net spend at 1 pt per ¥100 (pointsPerCurrencyUnit: 0.01) -> 100 points
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10000),
        currency: "JPY",
        pointsPerCurrencyUnit: 0.01,
        multiplier: 1.0,
      });
      expect(points).toBe(BigInt(100));
    });

    it("2.1.2: calculates points in VND (0-decimal) with large integer amounts", () => {
      // 5,000,000 VND net spend at 1 pt per 1,000 VND (0.001) -> 5,000 points
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(5000000),
        currency: "VND",
        pointsPerCurrencyUnit: 0.001,
        multiplier: 1.0,
      });
      expect(points).toBe(BigInt(5000));
    });

    it("2.1.3: calculates points in KRW (0-decimal) with tier multiplier", () => {
      // 100,000 KRW @ 0.01 rate with 1.5x multiplier -> Math.floor(100,000 * 0.015) = 1,500 points
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(100000),
        currency: "KRW",
        pointsPerCurrencyUnit: 0.01,
        multiplier: 1.5,
      });
      expect(points).toBe(BigInt(1500));
    });

    it("2.1.4: points liability calculation for JPY has zero decimal places in output", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(25000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const liability = await calculatePointsLiability({
        storeId: "store_yamax",
        currency: "JPY",
        valuationPerPointMinorUnits: 1, // ¥1 per point
      });

      expect(liability.isZeroDecimal).toBe(true);
      expect(liability.totalLiabilityDecimal).toBe("25000"); // No ".00"
      expect(liability.totalLiabilityMinorUnits).toBe(BigInt(25000));
    });

    it("2.1.5: points liability calculation for USD preserves 2-decimal formatting", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(2500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const liability = await calculatePointsLiability({
        storeId: "store_usd",
        currency: "USD",
        valuationPerPointMinorUnits: 1, // 1 cent per point
      });

      expect(liability.isZeroDecimal).toBe(false);
      expect(liability.totalLiabilityDecimal).toBe("25.00");
    });
  });

  // ===========================================================================
  // BOUNDARY 2: 30-Day Birthday Anti-Gaming Lockout Matrix
  // ===========================================================================
  describe("Boundary 2: 30-Day Birthday Anti-Gaming Lockout Matrix", () => {
    it("2.2.1: sweeps -60d to +60d lead times with exact sharp cutoff at 30 days", () => {
      const now = new Date("2026-08-15T00:00:00Z");
      const birthdayStr = "1995-08-15"; // Birthday is today (Aug 15)

      // Registration 29 days ago (July 17) -> LOCKED OUT
      const res29 = checkBirthdayEligibility(
        birthdayStr,
        "2026-07-17T00:00:00Z",
        now,
      );
      expect(res29.isLockedOut).toBe(true);
      expect(res29.leadTimeDays).toBe(29);
      expect(res29.nextEligibleYear).toBe(2027);

      // Registration exactly 30 days ago (July 16) -> ELIGIBLE
      const res30 = checkBirthdayEligibility(
        birthdayStr,
        "2026-07-16T00:00:00Z",
        now,
      );
      expect(res30.isEligible).toBe(true);
      expect(res30.isLockedOut).toBe(false);
      expect(res30.leadTimeDays).toBe(30);
      expect(res30.nextEligibleYear).toBe(2026);

      // Registration 31 days ago (July 15) -> ELIGIBLE
      const res31 = checkBirthdayEligibility(
        birthdayStr,
        "2026-07-15T00:00:00Z",
        now,
      );
      expect(res31.isEligible).toBe(true);
      expect(res31.leadTimeDays).toBe(31);
    });

    it("2.2.2: handles registration on birthday day itself (0 days lead time) -> Locked Out", () => {
      const now = new Date("2026-04-10T14:30:00Z");
      const res = checkBirthdayEligibility(
        "1992-04-10",
        "2026-04-10T08:00:00Z",
        now,
      );
      expect(res.isLockedOut).toBe(true);
      expect(res.leadTimeDays).toBe(0);
      expect(res.nextEligibleYear).toBe(2027);
    });

    it("2.2.3: handles registration after birthday in current calendar year (negative lead time) -> Locked Out", () => {
      const now = new Date("2026-11-01T00:00:00Z");
      const res = checkBirthdayEligibility(
        "1990-03-20", // March 20 birthday
        "2026-10-01T00:00:00Z", // Registered in October
        now,
      );
      expect(res.isLockedOut).toBe(true);
      expect(res.leadTimeDays).toBeLessThan(0);
      expect(res.nextEligibleYear).toBe(2027);
    });

    it("2.2.4: evaluates leap year Feb 29 across leap (2028), non-leap (2026), and century years", () => {
      // Non-leap year 2026: Feb 29 clamps to Feb 28
      const res2026 = checkBirthdayEligibility(
        "2000-02-29",
        "2025-01-01T00:00:00Z",
        new Date("2026-02-28T00:00:00Z"),
      );
      expect(res2026.isEligible).toBe(true);
      expect(res2026.birthdayThisYear.getUTCDate()).toBe(28);

      // Leap year 2028: Feb 29 is real date
      const res2028 = checkBirthdayEligibility(
        "2000-02-29",
        "2027-01-01T00:00:00Z",
        new Date("2028-02-29T00:00:00Z"),
      );
      expect(res2028.isEligible).toBe(true);
      expect(res2028.birthdayThisYear.getUTCDate()).toBe(29);
    });

    it("2.2.5: aligns UTC midnight day-boundary transitions seamlessly across calendar year-end (Dec 31 to Jan 1)", () => {
      const nowJan1 = new Date("2027-01-01T00:00:01Z");
      const res = checkBirthdayEligibility(
        "1995-01-20",
        "2026-12-01T00:00:00Z", // Registered Dec 1, 2026 (31 days prior)
        nowJan1,
      );
      expect(res.isEligible).toBe(true);
      expect(res.calendarYear).toBe(2027);
    });
  });

  // ===========================================================================
  // BOUNDARY 3: 30-Day VIP Soft-Downgrade Grace Period & Step-Down Demotion
  // ===========================================================================
  describe("Boundary 3: 30-Day VIP Soft-Downgrade Grace Period & Demotion Matrix", () => {
    const defaultTiers = [
      {
        id: "wtier_bronze",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
      },
      {
        id: "wtier_silver",
        name: "Silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(20000),
        minPointsThreshold: BigInt(200),
      },
      {
        id: "wtier_gold",
        name: "Gold",
        tierOrder: 3,
        minSpendThreshold: BigInt(50000),
        minPointsThreshold: BigInt(500),
      },
      {
        id: "wtier_plat",
        name: "Platinum",
        tierOrder: 4,
        minSpendThreshold: BigInt(100000),
        minPointsThreshold: BigInt(1000),
      },
    ];

    it("2.3.1: Day 0: enters grace period when annual review spend drops below threshold", async () => {
      const now = new Date("2026-08-01T00:00:00Z");
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_1",
        storeId: "store_1",
        currentTierId: "wtier_gold",
        tierExpiresAt: null,
        currentTier: defaultTiers[2],
        program: { tiers: defaultTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) }, // $100 < $500 threshold
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [] as any,
      );

      const res = await evaluateTierMaintenanceCycle({
        storeId: "store_1",
        accountId: "wacc_1",
        now,
      });

      expect(res.status).toBe("IN_GRACE_PERIOD");
      expect(res.newTierId).toBe("wtier_gold"); // Tier preserved
      const expectedEnd = new Date(now.getTime() + 30 * 86400000);
      expect(res.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedEnd.toISOString(),
      );
    });

    it("2.3.2: Day 29: remains IN_GRACE_PERIOD and retains VIP privileges", async () => {
      const now = new Date("2026-08-30T00:00:00Z");
      const graceEnd = new Date("2026-08-31T00:00:00Z"); // 1 day remaining

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_1",
        storeId: "store_1",
        currentTierId: "wtier_gold",
        tierExpiresAt: graceEnd,
        currentTier: defaultTiers[2],
        program: { tiers: defaultTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [] as any,
      );

      const res = await evaluateTierMaintenanceCycle({
        storeId: "store_1",
        accountId: "wacc_1",
        now,
      });

      expect(res.status).toBe("IN_GRACE_PERIOD");
      expect(res.newTierId).toBe("wtier_gold");
    });

    it("2.3.3: Day 30 / Day 31: executes single-tier step-down demotion (Platinum -> Gold, not straight to Bronze)", async () => {
      const now = new Date("2026-09-01T00:00:00Z");
      const expiredGrace = new Date("2026-08-31T00:00:00Z"); // Expired yesterday

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_plat_expired",
        storeId: "store_1",
        currentTierId: "wtier_plat",
        tierExpiresAt: expiredGrace,
        currentTier: defaultTiers[3], // Platinum (Rank 4)
        program: { tiers: defaultTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(0) }, // Zero spend
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [] as any,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValueOnce(
        {} as any,
      );

      const res = await evaluateTierMaintenanceCycle({
        storeId: "store_1",
        accountId: "wacc_plat_expired",
        now,
      });

      expect(res.status).toBe("DEMOTED");
      expect(res.newTierId).toBe("wtier_gold"); // Steps down 1 tier to Gold (Rank 3), NOT Bronze!
      expect(res.newTierName).toBe("Gold");
    });

    it("2.3.4: handles non-contiguous tier rank gaps ([1, 5, 10, 20]) gracefully stepping down to immediately preceding rank", async () => {
      const nonContiguousTiers = [
        {
          id: "t1",
          name: "Rank 1",
          tierOrder: 1,
          minSpendThreshold: BigInt(0),
          minPointsThreshold: BigInt(0),
        },
        {
          id: "t5",
          name: "Rank 5",
          tierOrder: 5,
          minSpendThreshold: BigInt(10000),
          minPointsThreshold: BigInt(100),
        },
        {
          id: "t10",
          name: "Rank 10",
          tierOrder: 10,
          minSpendThreshold: BigInt(50000),
          minPointsThreshold: BigInt(500),
        },
        {
          id: "t20",
          name: "Rank 20",
          tierOrder: 20,
          minSpendThreshold: BigInt(100000),
          minPointsThreshold: BigInt(1000),
        },
      ];

      const now = new Date("2026-09-01T00:00:00Z");
      const expiredGrace = new Date("2026-08-31T00:00:00Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_gap",
        storeId: "store_1",
        currentTierId: "t20",
        tierExpiresAt: expiredGrace,
        currentTier: nonContiguousTiers[3],
        program: { tiers: nonContiguousTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
        [] as any,
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [] as any,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValueOnce(
        {} as any,
      );

      const res = await evaluateTierMaintenanceCycle({
        storeId: "store_1",
        accountId: "wacc_gap",
        now,
      });

      expect(res.status).toBe("DEMOTED");
      expect(res.newTierId).toBe("t10"); // Steps down from 20 -> 10
    });

    it("2.3.5: promotes leapfrogging directly from Bronze to Platinum when high spend is achieved in a single cycle", async () => {
      const now = new Date("2026-08-15T00:00:00Z");
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_leap",
        storeId: "store_1",
        currentTierId: "wtier_bronze",
        tierExpiresAt: null,
        currentTier: defaultTiers[0],
        program: { tiers: defaultTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(150000) }, // $1,500 > $1,000 Platinum threshold
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(1500) }] as any,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValueOnce(
        {} as any,
      );

      const res = await evaluateTierMaintenanceCycle({
        storeId: "store_1",
        accountId: "wacc_leap",
        now,
      });

      expect(res.status).toBe("PROMOTED");
      expect(res.newTierId).toBe("wtier_plat"); // Direct leapfrog!
      expect(res.newTierName).toBe("Platinum");
    });
  });

  // ===========================================================================
  // BOUNDARY 4: Minimum Spend and Subtotal Thresholds
  // ===========================================================================
  describe("Boundary 4: Minimum Spend & Subtotal Thresholds", () => {
    it("2.4.1: order net amount $0.00 returns BigInt(0) points", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(0),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
      });
      expect(points).toBe(BigInt(0));
    });

    it("2.4.2: order net amount negative (over-refunded or adjusted) returns BigInt(0) points", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(-500),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
      });
      expect(points).toBe(BigInt(0));
    });

    it("2.4.3: order subtotal exactly 1 cent below threshold ($49.99 < $50.00) earns 0 points", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(4999),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        minOrderSubtotalCents: BigInt(5000), // $50 min
      });
      expect(points).toBe(BigInt(0));
    });

    it("2.4.4: order subtotal exactly at threshold ($50.00 == $50.00) earns full 50 points", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(5000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(points).toBe(BigInt(50));
    });

    it("2.4.5: order subtotal 1 cent above threshold ($50.01 > $50.00) earns full 50 points", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(5001),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(points).toBe(BigInt(50));
    });
  });

  // ===========================================================================
  // BOUNDARY 5: Negative & Zero Points Balances (Late Refund Post-Redemption)
  // ===========================================================================
  describe("Boundary 5: Negative & Zero Points Balances", () => {
    it("2.5.1: tolerates negative balance when full refund happens after points redemption", async () => {
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_1",
        cachedPointsBalance: BigInt(50), // Alice has 50 points left after spending 500
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(550),
        lifetimePointsRedeemed: BigInt(500),
        ledgerVersion: 5,
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce({
        sequenceNumber: 5,
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_refund_neg",
        sequenceNumber: 6,
        pointsDelta: BigInt(-200), // Reversing 200 points from original order
        balanceAfter: BigInt(-150), // Negative balance!
      } as any);

      const entry = await appendPointsLedgerEntry({
        storeId: "store_1",
        accountId: "wacc_1",
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: -200,
        idempotencyKey: "refund_rev_ord_1",
      });

      expect(entry.balanceAfter).toBe(BigInt(-150));
    });

    it("2.5.2: blocks redemption attempts when balance is zero or negative", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "wacc_neg",
        shopper: { shopifyCustomerId: "gid://shopify/Customer/negative" },
        store: { projectId: "workspace_smile_boundaries" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_neg",
        storeId: "store_1",
        status: "active",
        cachedPointsBalance: BigInt(-150),
        program: { status: "active", killSwitchActive: false },
      } as any);
      vi.mocked(
        prisma.weleticRewardDefinition.findUnique,
      ).mockResolvedValueOnce({
        id: "rew_5off",
        storeId: "store_1",
        pointsCost: BigInt(500),
        status: WeleticRewardStatus.active,
      } as any);

      await expect(
        redeemReward({
          storeId: "store_1",
          accountId: "wacc_neg",
          rewardDefinitionId: "rew_5off",
          idempotencyKey: "smile-tier2-negative-balance-1",
        }),
      ).rejects.toThrow("Insufficient points balance");
    });

    it("2.5.3: automatically recovers out of negative balance debt on subsequent qualifying order", async () => {
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "wacc_neg",
        cachedPointsBalance: BigInt(-150),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(550),
        lifetimePointsRedeemed: BigInt(500),
        ledgerVersion: 6,
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce({
        sequenceNumber: 6,
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_earn_recover",
        sequenceNumber: 7,
        pointsDelta: BigInt(200), // Earn 200 points on new purchase
        balanceAfter: BigInt(50), // Balance returns positive: -150 + 200 = +50!
      } as any);

      const entry = await appendPointsLedgerEntry({
        storeId: "store_1",
        accountId: "wacc_neg",
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: 200,
        idempotencyKey: "earn_recovery_order",
      });

      expect(entry.balanceAfter).toBe(BigInt(50));
    });

    it("2.5.4: points liability engine separates negative debt from circulating liability", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(-200),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const liability = await calculatePointsLiability({
        storeId: "store_1",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(liability.totalCirculatingPoints).toBe(BigInt(1000)); // Only positive points
      expect(liability.negativeBalancePointsDebt).toBe(BigInt(200));
      expect(liability.netCirculatingPoints).toBe(BigInt(800)); // 1000 - 200 = 800
      expect(liability.negativeBalanceAccountsCount).toBe(1);
    });
  });

  // ===========================================================================
  // BOUNDARY 6: BigInt Overflow, Numeric Bounds & Safe Integers
  // ===========================================================================
  describe("Boundary 6: BigInt Arithmetic & Safe Integer Limits", () => {
    it("2.6.1: handles extreme large point balances without numeric truncation", () => {
      const hugeSpend = BigInt("100000000000000"); // 1 trillion cents
      const points = calculateEligibleOrderPoints({
        netAmountCents: hugeSpend,
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
      });
      expect(points).toBe(BigInt("1000000000000")); // 1 trillion points
    });

    it("2.6.2: meta payload builder handles extreme numeric values safely", () => {
      const updates = buildCustomerMetafieldUpdates({
        ownerId: "gid://shopify/Customer/1",
        pointsBalance: BigInt("9007199254740991"), // Number.MAX_SAFE_INTEGER
        lifetimePoints: BigInt("100000000000000000"), // Beyond MAX_SAFE_INTEGER
      });

      const pts = updates.find((u) => u.key === "points_balance");
      const life = updates.find((u) => u.key === "lifetime_points");

      expect(pts?.value).toBe("9007199254740991");
      expect(life?.value).toBe("100000000000000000");
    });
  });
});
